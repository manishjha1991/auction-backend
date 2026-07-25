/**
 * Single source of truth for fixture result persistence.
 * Used by POST /api/fixtures/save and fixture submission approval.
 */
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const headToHeadModule = require('../routes/headToHead');
const { invalidateCache } = require('./cache');
const { emitPointsTableUpdated } = require('./emitPointsTableUpdate');
const { applyCareerLeagueResult, revertCareerLeagueResult } = require('./careerUserCounters');

const SCORE_FORMAT_REGEX = /^\d+\/\d+$/;

const normalizeTeamKey = (value = '') =>
  String(value || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match User by exact teamName, then case-insensitive, then normalized key via userId on fixture. */
async function findUserForTeam(teamName, userId) {
  if (userId) {
    const byId = await User.findById(userId);
    if (byId) return byId;
  }
  if (!teamName || !String(teamName).trim()) return null;

  const trimmed = String(teamName).trim();
  const exact = await User.findOne({ teamName: trimmed });
  if (exact) return exact;

  const loose = await User.findOne({
    teamName: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') },
  });
  if (loose) return loose;

  const key = normalizeTeamKey(trimmed);
  if (!key) return null;

  const candidates = await User.find({
    teamName: { $exists: true, $nin: [null, '', 'NA'] },
    isAdmin: { $ne: true },
  })
    .select('teamName')
    .lean();

  const hit = candidates.find((u) => normalizeTeamKey(u.teamName) === key);
  return hit ? User.findById(hit._id) : null;
}

/** Load both team owners by fixture user IDs — never by team name string. */
async function loadFixtureTeamUsers(fixture) {
  if (!fixture?.team1UserId || !fixture?.team2UserId) {
    throw new Error(
      `Fixture "${fixture?.team1 || '?'} vs ${fixture?.team2 || '?'}" is missing team user IDs. Cannot update points table.`
    );
  }

  const [team1User, team2User] = await Promise.all([
    User.findById(fixture.team1UserId),
    User.findById(fixture.team2UserId),
  ]);

  if (!team1User || !team2User) {
    throw new Error(
      `Could not load both team users for fixture ${fixture._id} (team1UserId=${fixture.team1UserId}, team2UserId=${fixture.team2UserId}).`
    );
  }

  return { team1User, team2User };
}

/**
 * Which team won — resolved via user IDs on the fixture, with normalized name fallback.
 * Returns team1UserId or team2UserId of the winning side.
 */
function resolveWinnerUserId(winner, fixture) {
  if (!winner || !fixture) return null;

  const winnerStr = String(winner).trim();
  if (fixture.team1UserId && winnerStr === String(fixture.team1UserId)) return fixture.team1UserId;
  if (fixture.team2UserId && winnerStr === String(fixture.team2UserId)) return fixture.team2UserId;

  const wKey = normalizeTeamKey(winnerStr);
  if (!wKey) return null;

  if (fixture.team1UserId && wKey === normalizeTeamKey(fixture.team1)) return fixture.team1UserId;
  if (fixture.team2UserId && wKey === normalizeTeamKey(fixture.team2)) return fixture.team2UserId;

  return null;
}

/** Map OCR/submission winner to the fixture's canonical team1 or team2 display string. */
function resolveWinnerName(winner, fixture) {
  if (!winner || !fixture) return winner;

  const winnerUserId = resolveWinnerUserId(winner, fixture);
  if (winnerUserId && fixture.team1UserId && String(winnerUserId) === String(fixture.team1UserId)) {
    return fixture.team1;
  }
  if (winnerUserId && fixture.team2UserId && String(winnerUserId) === String(fixture.team2UserId)) {
    return fixture.team2;
  }

  const wKey = normalizeTeamKey(winner);
  if (wKey && wKey === normalizeTeamKey(fixture.team1)) return fixture.team1;
  if (wKey && wKey === normalizeTeamKey(fixture.team2)) return fixture.team2;
  return winner;
}

function isTeam1Winner(fixture, winner) {
  const winnerUserId = resolveWinnerUserId(winner, fixture);
  if (winnerUserId && fixture.team1UserId) {
    return String(winnerUserId) === String(fixture.team1UserId);
  }
  return resolveWinnerName(winner, fixture) === fixture.team1;
}

async function revertPointsTableStats(fixture, winner, team1Fairness, team2Fairness) {
  const { team1User, team2User } = await loadFixtureTeamUsers(fixture);
  const winnerUserId = resolveWinnerUserId(winner, fixture);
  if (!winnerUserId) {
    throw new Error(`Cannot revert points: unknown winner "${winner}" for fixture ${fixture._id}`);
  }

  if (String(winnerUserId) === String(fixture.team1UserId)) {
    team1User.points = Math.max(0, (team1User.points || 0) - 2);
  } else {
    team2User.points = Math.max(0, (team2User.points || 0) - 2);
  }

  team1User.fairnessPoint = Math.max(0, (team1User.fairnessPoint || 0) - (team1Fairness || 0));
  team2User.fairnessPoint = Math.max(0, (team2User.fairnessPoint || 0) - (team2Fairness || 0));
  team1User.matchesPlayed = Math.max(0, (team1User.matchesPlayed || 0) - 1);
  team2User.matchesPlayed = Math.max(0, (team2User.matchesPlayed || 0) - 1);

  await Promise.all([team1User.save(), team2User.save()]);
}

async function applyPointsTableStats(fixture) {
  const { team1User, team2User } = await loadFixtureTeamUsers(fixture);
  const winnerUserId = resolveWinnerUserId(fixture.winner, fixture);
  if (!winnerUserId) {
    throw new Error(
      `Cannot update points table: winner "${fixture.winner}" does not match either team in fixture ${fixture._id}.`
    );
  }

  if (String(winnerUserId) === String(fixture.team1UserId)) {
    team1User.points = (team1User.points || 0) + 2;
  } else if (String(winnerUserId) === String(fixture.team2UserId)) {
    team2User.points = (team2User.points || 0) + 2;
  } else {
    throw new Error(`Winner user ${winnerUserId} is not part of fixture ${fixture._id}`);
  }

  team1User.fairnessPoint = (team1User.fairnessPoint || 0) + (fixture.team1Fairness || 0);
  team2User.fairnessPoint = (team2User.fairnessPoint || 0) + (fixture.team2Fairness || 0);
  team1User.matchesPlayed = (team1User.matchesPlayed || 0) + 1;
  team2User.matchesPlayed = (team2User.matchesPlayed || 0) + 1;

  await Promise.all([team1User.save(), team2User.save()]);
}

function validateFixturePayload(body) {
  const {
    team1Score,
    team2Score,
    team1Overs,
    team2Overs,
    team1,
    team2,
  } = body;

  if (team1Score && !SCORE_FORMAT_REGEX.test(String(team1Score).trim())) {
    throw new Error(
      `Team 1 score format is invalid. Expected runs/wickets (e.g. "107/10"). Received: "${team1Score}"`
    );
  }
  if (team2Score && !SCORE_FORMAT_REGEX.test(String(team2Score).trim())) {
    throw new Error(
      `Team 2 score format is invalid. Expected runs/wickets (e.g. "107/10"). Received: "${team2Score}"`
    );
  }

  const team1OversStr = String(team1Overs || '').trim();
  const team2OversStr = String(team2Overs || '').trim();
  if (!team1OversStr) throw new Error('Team 1 overs is required');
  if (!team2OversStr) throw new Error('Team 2 overs is required');

  return { team1OversStr, team2OversStr };
}

async function assertTeamsParticipating(team1, team2, team1UserId, team2UserId) {
  if (!team1 && !team2) return;

  const team1User = await findUserForTeam(team1, team1UserId);
  const team2User = await findUserForTeam(team2, team2UserId);

  if (team1User && team1User.isParticipating === false) {
    throw new Error(`${team1} is not participating in the current season. Cannot create or update fixture.`);
  }
  if (team2User && team2User.isParticipating === false) {
    throw new Error(`${team2} is not participating in the current season. Cannot create or update fixture.`);
  }
}

async function findFixtureDocument(body) {
  const {
    _id,
    team1,
    team2,
    team1UserId,
    team2UserId,
  } = body;

  let fixture = null;

  if (_id) {
    try {
      fixture = await Fixture.findById(_id);
    } catch (idError) {
      console.error(`Error finding fixture by _id ${_id}:`, idError.message);
    }
  }

  if (!fixture && team1 && team2) {
    let userId1 = team1UserId || null;
    let userId2 = team2UserId || null;

    if (!userId1 || !userId2) {
      const team1UserLookup = await findUserForTeam(team1, userId1);
      const team2UserLookup = await findUserForTeam(team2, userId2);
      userId1 = userId1 || (team1UserLookup ? team1UserLookup._id : null);
      userId2 = userId2 || (team2UserLookup ? team2UserLookup._id : null);
    }

    if (userId1 && userId2) {
      fixture = await Fixture.findOne({
        $or: [
          { team1UserId: userId1, team2UserId: userId2 },
          { team1UserId: userId2, team2UserId: userId1 },
        ],
        isActive: true,
      });
    }

    if (!fixture) {
      fixture = await Fixture.findOne({ team1, team2, isActive: true });
    }
  }

  return fixture;
}

/**
 * Same payload shape as POST /api/fixtures/save (Fixtures.js handleSaveFixture).
 * OCR approval and manual fixture edit both build this, then call saveFixtureResult().
 */
function buildFixtureSavePayload(fixture, fields) {
  return {
    _id: fixture._id,
    team1: fixture.team1,
    team2: fixture.team2,
    team1UserId: fixture.team1UserId,
    team2UserId: fixture.team2UserId,
    group: fixture.group,
    matchType: fixture.matchType,
    winner: fields.winner,
    margin: fields.margin,
    team1Score: fields.team1Score,
    team2Score: fields.team2Score,
    team1Overs: fields.team1Overs,
    team2Overs: fields.team2Overs,
    mom: fields.mom,
    team1Fairness: fields.team1Fairness,
    team2Fairness: fields.team2Fairness,
  };
}

/** Align request body with the fixture record in DB (user IDs win over display names). */
function normalizeBodyWithFixture(body, fixture) {
  const normalized = { ...body, _id: fixture._id };

  normalized.team1UserId = fixture.team1UserId;
  normalized.team2UserId = fixture.team2UserId;
  normalized.team1 = fixture.team1;
  normalized.team2 = fixture.team2;
  normalized.group = body.group !== undefined ? body.group : fixture.group;
  normalized.matchType = body.matchType !== undefined ? body.matchType : fixture.matchType;

  if (body.winner != null && body.winner !== '') {
    const winnerUserId = resolveWinnerUserId(body.winner, fixture);
    if (!winnerUserId) {
      throw new Error(
        `Winner "${body.winner}" does not match either team in this fixture. Pick the winning team and try again.`
      );
    }
    normalized.winner =
      String(winnerUserId) === String(fixture.team1UserId) ? fixture.team1 : fixture.team2;
  }

  return normalized;
}

/**
 * @param {object} body Same shape as POST /api/fixtures/save body
 * @param {object} [options]
 * @param {import('express').Request} [options.req] For socket emit on points table update
 */
async function saveFixtureResult(body, options = {}) {
  let fixture = await findFixtureDocument(body);
  const saveBody = fixture ? normalizeBodyWithFixture(body, fixture) : body;

  const {
    _id,
    team1,
    team2,
    team1UserId,
    team2UserId,
    winner,
    margin,
    mom,
    team1Score,
    team2Score,
    team1Overs,
    team2Overs,
    team1Fairness,
    team2Fairness,
    group,
    matchType,
  } = saveBody;

  await assertTeamsParticipating(team1, team2, team1UserId, team2UserId);
  const { team1OversStr, team2OversStr } = validateFixturePayload(saveBody);

  let oldWinnerBeforeSave = null;
  let prevStatsApplied = false;
  let prevTeam1Fairness = 0;
  let prevTeam2Fairness = 0;
  const canonicalWinner =
    winner !== undefined && winner !== null && fixture
      ? resolveWinnerName(winner, fixture)
      : winner !== undefined && winner !== null
        ? winner
        : undefined;

  if (!fixture) {
    let finalUserId1 = team1UserId || null;
    let finalUserId2 = team2UserId || null;

    if (!finalUserId1 && team1) {
      const team1User = await findUserForTeam(team1, null);
      finalUserId1 = team1User?._id || null;
    }
    if (!finalUserId2 && team2) {
      const team2User = await findUserForTeam(team2, null);
      finalUserId2 = team2User?._id || null;
    }

    fixture = new Fixture({
      team1,
      team2,
      team1UserId: finalUserId1,
      team2UserId: finalUserId2,
      winner: canonicalWinner,
      margin,
      mom: mom
        ? {
            name: mom.name || null,
            score: mom.score !== undefined ? mom.score : null,
            wickets: mom.wickets !== undefined ? mom.wickets : null,
          }
        : null,
      team1Score,
      team2Score,
      team1Overs: team1OversStr,
      team2Overs: team2OversStr,
      team1Fairness,
      team2Fairness,
      group: group || null,
      matchType: matchType || 'normal',
    });
  } else {
    oldWinnerBeforeSave = fixture.winner;
    prevStatsApplied = !!fixture.pointsTableApplied;
    prevTeam1Fairness = fixture.team1Fairness || 0;
    prevTeam2Fairness = fixture.team2Fairness || 0;
    if (canonicalWinner !== undefined) fixture.winner = resolveWinnerName(canonicalWinner, fixture);
    if (margin !== undefined) fixture.margin = margin;
    if (mom !== undefined) {
      fixture.mom = {
        name: mom.name || null,
        score: mom.score !== undefined ? mom.score : null,
        wickets: mom.wickets !== undefined ? mom.wickets : null,
      };
    }
    if (team1Score !== undefined) fixture.team1Score = team1Score;
    if (team2Score !== undefined) fixture.team2Score = team2Score;
    fixture.team1Overs = team1OversStr;
    fixture.team2Overs = team2OversStr;
    if (team1Fairness !== undefined) fixture.team1Fairness = team1Fairness;
    if (team2Fairness !== undefined) fixture.team2Fairness = team2Fairness;
    if (group !== undefined) fixture.group = group;
    if (matchType !== undefined) fixture.matchType = matchType;

    if (team1UserId && team1UserId !== fixture.team1UserId) {
      fixture.team1UserId = team1UserId;
    }
    if (team2UserId && team2UserId !== fixture.team2UserId) {
      fixture.team2UserId = team2UserId;
    }

    if (!fixture.team1UserId || !fixture.team2UserId) {
      const team1User = await findUserForTeam(fixture.team1, fixture.team1UserId);
      const team2User = await findUserForTeam(fixture.team2, fixture.team2UserId);
      if (team1User && !fixture.team1UserId) fixture.team1UserId = team1User._id;
      if (team2User && !fixture.team2UserId) fixture.team2UserId = team2User._id;
    }

    if (fixture.winner) {
      const winnerUserId = resolveWinnerUserId(fixture.winner, fixture);
      if (winnerUserId) fixture.winnerUserId = winnerUserId;
    }
  }

  if (!fixture.team1 || !fixture.team2) {
    throw new Error('Missing required fields: team1 and team2 are required');
  }

  if (fixture.winner && (!fixture.team1UserId || !fixture.team2UserId)) {
    throw new Error(
      `Cannot save result: fixture "${fixture.team1} vs ${fixture.team2}" is missing team1UserId or team2UserId.`
    );
  }

  if (fixture.winner && !resolveWinnerUserId(fixture.winner, fixture)) {
    throw new Error(
      `Cannot save result: winner "${fixture.winner}" does not match either team in this fixture.`
    );
  }

  await fixture.save();
  invalidateCache('fixtures:');

  if (fixture.winner) {
    if (oldWinnerBeforeSave && prevStatsApplied) {
      await revertPointsTableStats(
        fixture,
        oldWinnerBeforeSave,
        prevTeam1Fairness,
        prevTeam2Fairness
      );
    }

    await applyPointsTableStats(fixture);
    fixture.pointsTableApplied = true;
    await Fixture.updateOne({ _id: fixture._id }, { $set: { pointsTableApplied: true } });

    if (oldWinnerBeforeSave && oldWinnerBeforeSave !== fixture.winner && headToHeadModule.revertAndResyncForRecord) {
        Fixture.updateOne({ _id: fixture._id }, { $set: { headToHeadSynced: false } })
          .then(() =>
            headToHeadModule.revertAndResyncForRecord(fixture.team1, fixture.team2, oldWinnerBeforeSave)
          )
          .catch((err) => console.error('Head-to-head sync:', err));
      } else if (headToHeadModule.syncHeadToHead) {
        headToHeadModule.syncHeadToHead().catch((err) => console.error('Head-to-head sync:', err));
      }

      const shouldBumpCareer = !oldWinnerBeforeSave || oldWinnerBeforeSave !== fixture.winner;
      if (shouldBumpCareer) {
        applyCareerLeagueResult({
          team1: fixture.team1,
          team2: fixture.team2,
          newWinnerName: fixture.winner,
          oldWinnerName: oldWinnerBeforeSave || null,
        }).catch((err) => console.error('Career counters:', err));
      }
  }

  if (options.req) {
    emitPointsTableUpdated(options.req, { reason: 'fixture_saved' });
  }

  const fixtureResponse = fixture.toObject ? fixture.toObject() : fixture;
  return {
    message: 'Fixture result saved successfully! Points updated automatically.',
    fixture: fixtureResponse,
  };
}

/**
 * Clear a completed fixture result: revert points/MP if applied, null out result fields,
 * decrement career counters, and resync H2H. Used by forfeit Restore for previously-unplayed games.
 */
async function clearFixtureResult(fixtureId, options = {}) {
  const fixture = await Fixture.findById(fixtureId);
  if (!fixture) {
    throw new Error(`Fixture not found: ${fixtureId}`);
  }

  if (!fixture.winner) {
    return {
      message: 'Fixture already has no result.',
      fixture: fixture.toObject ? fixture.toObject() : fixture,
      cleared: false,
    };
  }

  const oldWinner = fixture.winner;
  const prevStatsApplied = !!fixture.pointsTableApplied;
  const prevTeam1Fairness = fixture.team1Fairness || 0;
  const prevTeam2Fairness = fixture.team2Fairness || 0;

  if (prevStatsApplied) {
    await revertPointsTableStats(fixture, oldWinner, prevTeam1Fairness, prevTeam2Fairness);
  }

  fixture.winner = null;
  fixture.winnerUserId = null;
  fixture.margin = null;
  fixture.team1Score = null;
  fixture.team2Score = null;
  fixture.team1Overs = null;
  fixture.team2Overs = null;
  fixture.mom = { name: null, score: null, wickets: null };
  fixture.team1Fairness = 0;
  fixture.team2Fairness = 0;
  fixture.pointsTableApplied = false;
  fixture.headToHeadSynced = false;
  await fixture.save();
  invalidateCache('fixtures:');

  try {
    await revertCareerLeagueResult({
      team1: fixture.team1,
      team2: fixture.team2,
      winnerName: oldWinner,
    });
  } catch (err) {
    console.error('Career counters (clear):', err);
  }

  if (headToHeadModule.syncHeadToHead) {
    headToHeadModule.syncHeadToHead().catch((err) => console.error('Head-to-head sync (clear):', err));
  }

  if (options.req) {
    emitPointsTableUpdated(options.req, { reason: 'fixture_cleared' });
  }

  return {
    message: 'Fixture result cleared. Points reverted.',
    fixture: fixture.toObject ? fixture.toObject() : fixture,
    cleared: true,
  };
}

module.exports = {
  saveFixtureResult,
  clearFixtureResult,
  buildFixtureSavePayload,
  resolveWinnerName,
  resolveWinnerUserId,
  buildFixtureSaveBodyFromSubmission(submission, fixture) {
    return buildFixtureSavePayload(fixture, {
      winner: submission.winner,
      margin: submission.margin,
      team1Score: submission.team1Score,
      team2Score: submission.team2Score,
      team1Overs: submission.team1Overs,
      team2Overs: submission.team2Overs,
      mom: submission.mom,
      team1Fairness: submission.team1Fairness,
      team2Fairness: submission.team2Fairness,
    });
  },
};
