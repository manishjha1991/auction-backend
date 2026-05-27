/**
 * Sync fixtures, required games, and playoffs when team participation changes.
 */
const User = require('../models/User');
const Fixture = require('../models/Fixture');
const PlayoffFixture = require('../models/PlayoffFixture');
const AppSettings = require('../models/AppSettings');
const { invalidateCache, clearAllCaches } = require('./cache');
const { invalidateCplReportCache } = require('./cplReadCaches');

const PARTICIPATING_TEAM_QUERY = {
  teamName: { $exists: true, $ne: null, $ne: 'NA' },
  isActive: true,
  isAdmin: { $ne: true },
  isParticipating: { $ne: false },
};

function buildFixtureKey(id1, id2) {
  return [id1.toString(), id2.toString()].sort().join('-');
}

async function getParticipatingTeams() {
  return User.find(PARTICIPATING_TEAM_QUERY)
    .select('_id teamName group')
    .lean();
}

function buildFixtureMap(existingFixtures) {
  const fixtureMap = new Set();
  existingFixtures.forEach((fixture) => {
    if (fixture.team1UserId && fixture.team2UserId) {
      fixtureMap.add(buildFixtureKey(fixture.team1UserId, fixture.team2UserId));
    } else {
      fixtureMap.add([fixture.team1, fixture.team2].sort().join('-'));
    }
  });
  return fixtureMap;
}

function appendPairFixtures(teams, fixtureMap, newFixtures, group, matchType) {
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const t1 = teams[i];
      const t2 = teams[j];
      const fixtureKey = buildFixtureKey(t1._id, t2._id);
      const teamNameKey = [t1.teamName, t2.teamName].sort().join('-');

      if (fixtureMap.has(fixtureKey) || fixtureMap.has(teamNameKey)) {
        continue;
      }

      newFixtures.push({
        team1: t1.teamName,
        team2: t2.teamName,
        team1UserId: t1._id,
        team2UserId: t2._id,
        group,
        matchType,
      });
      fixtureMap.add(fixtureKey);
    }
  }
}

async function syncFixturesForParticipatingTeams(mode) {
  const teams = await getParticipatingTeams();
  if (teams.length < 2) {
    return 0;
  }

  const existingFixtures = await Fixture.find({ isActive: true })
    .select('team1UserId team2UserId team1 team2')
    .lean();
  const fixtureMap = buildFixtureMap(existingFixtures);
  const newFixtures = [];

  if (mode === 'groups') {
    const groupA = teams.filter((team) => team.group === 'A');
    const groupB = teams.filter((team) => team.group === 'B');
    const ungroupedTeams = teams.filter((team) => !team.group);

    appendPairFixtures(groupA, fixtureMap, newFixtures, 'A', 'group');
    appendPairFixtures(groupB, fixtureMap, newFixtures, 'B', 'group');
    appendPairFixtures(ungroupedTeams, fixtureMap, newFixtures, null, 'normal');
  } else {
    appendPairFixtures(teams, fixtureMap, newFixtures, null, 'normal');
  }

  if (newFixtures.length > 0) {
    await Fixture.insertMany(newFixtures);
  }

  return newFixtures.length;
}

async function deactivatePendingFixturesForTeams(teamIds) {
  if (!teamIds.length) {
    return 0;
  }

  const users = await User.find({ _id: { $in: teamIds } }).select('teamName').lean();
  const teamNames = users.map((user) => user.teamName).filter(Boolean);

  const result = await Fixture.updateMany(
    {
      isActive: true,
      winner: null,
      $or: [
        { team1UserId: { $in: teamIds } },
        { team2UserId: { $in: teamIds } },
        ...(teamNames.length
          ? [{ team1: { $in: teamNames } }, { team2: { $in: teamNames } }]
          : []),
      ],
    },
    { $set: { isActive: false } }
  );

  return result.modifiedCount || 0;
}

function emitParticipationSync(io, summary) {
  try {
    invalidateCplReportCache();
  } catch (_) {
    /* ignore */
  }

  invalidateCache('fixtures:');
  clearAllCaches();

  if (io && typeof io.emit === 'function') {
    io.emit('points_table_updated', {
      at: new Date().toISOString(),
      reason: 'participation_sync',
      ...summary,
    });
  }
}

/**
 * Apply participation flag updates and sync fixtures / playoffs / required games.
 * @param {Array<{ teamId: string, isParticipating: boolean }>} teamUpdates
 * @param {{ io?: import('socket.io').Server }} [options]
 */
async function applyParticipationChanges(teamUpdates, options = {}) {
  const { io } = options;

  if (!Array.isArray(teamUpdates) || teamUpdates.length === 0) {
    return {
      updated: 0,
      enrolled: 0,
      withdrawn: 0,
      fixturesAdded: 0,
      fixturesRemoved: 0,
      newRequiredGames: null,
      playoffsReset: false,
      participationChanged: false,
    };
  }

  const teamIds = teamUpdates.map(({ teamId }) => teamId);
  const currentTeams = await User.find({ _id: { $in: teamIds } })
    .select('_id teamName isParticipating')
    .lean();
  const currentMap = new Map(
    currentTeams.map((team) => [team._id.toString(), team.isParticipating !== false])
  );

  const enrolled = [];
  const withdrawn = [];
  const updateDetails = [];

  for (const { teamId, isParticipating } of teamUpdates) {
    const newStatus = !!isParticipating;
    const oldStatus = currentMap.get(teamId.toString());

    if (oldStatus === undefined) {
      continue;
    }

    const updatePayload = { isParticipating: newStatus };
    if (newStatus && !oldStatus) {
      updatePayload.isTournamentReady = true;
      enrolled.push(teamId);
    } else if (!newStatus && oldStatus) {
      withdrawn.push(teamId);
    }

    await User.findByIdAndUpdate(teamId, { $set: updatePayload });

    const team = currentTeams.find((entry) => entry._id.toString() === teamId.toString());
    updateDetails.push({
      team: team?.teamName || teamId,
      status: newStatus ? 'PARTICIPATING' : 'NOT PARTICIPATING',
    });
  }

  const participationChanged = enrolled.length > 0 || withdrawn.length > 0;
  let fixturesAdded = 0;
  let fixturesRemoved = 0;
  let playoffsReset = false;
  let newRequiredGames = null;

  if (participationChanged) {
    const settings = await AppSettings.findOne().lean();
    const mode = settings?.pointsMode || 'overall';

    if (withdrawn.length > 0) {
      fixturesRemoved = await deactivatePendingFixturesForTeams(withdrawn);
    }

    fixturesAdded = await syncFixturesForParticipatingTeams(mode);

    const participatingTeams = await getParticipatingTeams();
    newRequiredGames = participatingTeams.length > 1 ? participatingTeams.length - 1 : 13;
    await AppSettings.findOneAndUpdate(
      {},
      { $set: { requiredGames: newRequiredGames } },
      { upsert: true }
    );

    const playoffCount = await PlayoffFixture.countDocuments({});
    if (playoffCount > 0) {
      await PlayoffFixture.deleteMany({});
      playoffsReset = true;
    }

    emitParticipationSync(io, {
      enrolled: enrolled.length,
      withdrawn: withdrawn.length,
      fixturesAdded,
      fixturesRemoved,
      newRequiredGames,
      playoffsReset,
    });
  }

  return {
    updated: updateDetails.length,
    enrolled: enrolled.length,
    withdrawn: withdrawn.length,
    fixturesAdded,
    fixturesRemoved,
    newRequiredGames,
    playoffsReset,
    participationChanged,
    updateDetails,
  };
}

module.exports = {
  applyParticipationChanges,
  getParticipatingTeams,
  syncFixturesForParticipatingTeams,
};
