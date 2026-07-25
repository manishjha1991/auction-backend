/**
 * Admin one-click league forfeit / restore for a team.
 * Forfeit: reverse that team's wins + award remaining fixtures to opponents (walkover).
 * Restore: re-apply the pre-forfeit snapshot.
 */
const Fixture = require('../models/Fixture');
const FixtureSubmission = require('../models/FixtureSubmission');
const User = require('../models/User');
const {
  saveFixtureResult,
  clearFixtureResult,
  buildFixtureSavePayload,
  resolveWinnerUserId,
} = require('./fixtureSaveService');
const { emitPointsTableUpdated } = require('./emitPointsTableUpdate');

const WALKOVER_MARGIN = 'walkover (forfeit)';

function snapshotFromFixture(fixture) {
  return {
    fixtureId: fixture._id,
    winner: fixture.winner || null,
    winnerUserId: fixture.winnerUserId || null,
    team1Score: fixture.team1Score || null,
    team2Score: fixture.team2Score || null,
    team1Overs: fixture.team1Overs || null,
    team2Overs: fixture.team2Overs || null,
    margin: fixture.margin || null,
    mom: fixture.mom
      ? {
          name: fixture.mom.name || null,
          score: fixture.mom.score !== undefined ? fixture.mom.score : null,
          wickets: fixture.mom.wickets !== undefined ? fixture.mom.wickets : null,
        }
      : { name: null, score: null, wickets: null },
    team1Fairness: fixture.team1Fairness || 0,
    team2Fairness: fixture.team2Fairness || 0,
    pointsTableApplied: !!fixture.pointsTableApplied,
  };
}

function teamWonFixture(fixture, teamUserId) {
  if (!fixture.winner || !teamUserId) return false;
  const winnerUserId = resolveWinnerUserId(fixture.winner, fixture);
  if (winnerUserId) return String(winnerUserId) === String(teamUserId);
  return false;
}

function opponentName(fixture, teamUserId) {
  if (fixture.team1UserId && String(fixture.team1UserId) === String(teamUserId)) {
    return fixture.team2;
  }
  return fixture.team1;
}

function isTeam1Side(fixture, teamUserId) {
  return fixture.team1UserId && String(fixture.team1UserId) === String(teamUserId);
}

function walkoverPayload(fixture, opponentWinnerName, forfeitingUserId) {
  const forfeiterIsTeam1 = isTeam1Side(fixture, forfeitingUserId);
  // Forfeiting side: 0/10 in 0.0; winner: 1/0 in 0.1
  return buildFixtureSavePayload(fixture, {
    winner: opponentWinnerName,
    margin: WALKOVER_MARGIN,
    team1Score: forfeiterIsTeam1 ? '0/10' : '1/0',
    team2Score: forfeiterIsTeam1 ? '1/0' : '0/10',
    team1Overs: forfeiterIsTeam1 ? '0.0' : '0.1',
    team2Overs: forfeiterIsTeam1 ? '0.1' : '0.0',
    mom: { name: null, score: null, wickets: null },
    team1Fairness: 0,
    team2Fairness: 0,
  });
}

async function loadTeamFixtures(userId) {
  return Fixture.find({
    isActive: true,
    $or: [{ team1UserId: userId }, { team2UserId: userId }],
  }).sort({ createdAt: 1 });
}

async function assertNoPendingSubmissions(fixtureIds) {
  if (!fixtureIds.length) return;
  const pending = await FixtureSubmission.find({
    fixtureId: { $in: fixtureIds },
    status: 'pending',
  })
    .select('_id fixtureId team1 team2')
    .lean();

  if (pending.length) {
    const list = pending
      .map((p) => `${p.team1} vs ${p.team2} (${p._id})`)
      .join('; ');
    const err = new Error(
      `Cannot forfeit while pending fixture submissions exist. Resolve or reject them first: ${list}`
    );
    err.code = 'PENDING_SUBMISSIONS';
    err.pending = pending;
    throw err;
  }
}

/**
 * Preview what forfeit would change (no mutations).
 */
async function previewForfeit(userId) {
  const user = await User.findById(userId);
  if (!user) {
    throw Object.assign(new Error('Team not found'), { status: 404 });
  }
  if (user.isAdmin) {
    throw Object.assign(new Error('Cannot forfeit an admin account'), { status: 400 });
  }

  const fixtures = await loadTeamFixtures(userId);
  const winsToReverse = [];
  const remainingWalkovers = [];
  const alreadyLost = [];

  for (const fixture of fixtures) {
    if (!fixture.winner) {
      remainingWalkovers.push({
        fixtureId: fixture._id,
        team1: fixture.team1,
        team2: fixture.team2,
        opponent: opponentName(fixture, userId),
      });
    } else if (teamWonFixture(fixture, userId)) {
      winsToReverse.push({
        fixtureId: fixture._id,
        team1: fixture.team1,
        team2: fixture.team2,
        opponent: opponentName(fixture, userId),
      });
    } else {
      alreadyLost.push({
        fixtureId: fixture._id,
        team1: fixture.team1,
        team2: fixture.team2,
      });
    }
  }

  return {
    userId: String(user._id),
    teamName: user.teamName,
    forfeitActive: !!(user.leagueForfeit && user.leagueForfeit.active),
    winsToReverseCount: winsToReverse.length,
    remainingWalkoversCount: remainingWalkovers.length,
    alreadyLostCount: alreadyLost.length,
    winsToReverse,
    remainingWalkovers,
    alreadyLost,
    totalAffected: winsToReverse.length + remainingWalkovers.length,
  };
}

/**
 * Forfeit: snapshot then award opponent wins for prior wins + unplayed fixtures.
 */
async function forfeitTeam(userId, options = {}) {
  const user = await User.findById(userId);
  if (!user) {
    throw Object.assign(new Error('Team not found'), { status: 404 });
  }
  if (user.isAdmin) {
    throw Object.assign(new Error('Cannot forfeit an admin account'), { status: 400 });
  }
  if (user.leagueForfeit && user.leagueForfeit.active) {
    throw Object.assign(
      new Error(
        `${user.teamName || 'Team'} already has an active forfeit. Use Restore first before forfeiting again.`
      ),
      { status: 400, code: 'ALREADY_FORFEITED' }
    );
  }

  const fixtures = await loadTeamFixtures(userId);
  const toChange = [];

  for (const fixture of fixtures) {
    if (!fixture.team1UserId || !fixture.team2UserId) {
      throw Object.assign(
        new Error(
          `Fixture "${fixture.team1} vs ${fixture.team2}" is missing team user IDs. Fix the fixture before forfeiting.`
        ),
        { status: 400 }
      );
    }

    if (!fixture.winner) {
      toChange.push({ fixture, action: 'walkover' });
    } else if (teamWonFixture(fixture, userId)) {
      toChange.push({ fixture, action: 'flip' });
    }
  }

  if (!toChange.length) {
    throw Object.assign(
      new Error('Nothing to forfeit: no wins to reverse and no remaining unplayed fixtures.'),
      { status: 400 }
    );
  }

  await assertNoPendingSubmissions(toChange.map((c) => c.fixture._id));

  const snapshot = toChange.map((c) => snapshotFromFixture(c.fixture));
  user.leagueForfeit = {
    active: true,
    forfeitedAt: new Date(),
    snapshot,
  };
  await user.save();

  const succeeded = [];
  const errors = [];

  for (const { fixture, action } of toChange) {
    try {
      const opponent = opponentName(fixture, userId);
      let payload;
      if (action === 'walkover') {
        payload = walkoverPayload(fixture, opponent, userId);
      } else {
        // Flip win → keep scores/overs/MoM/fairness; only change winner (+ margin note)
        payload = buildFixtureSavePayload(fixture, {
          winner: opponent,
          margin: fixture.margin
            ? `${fixture.margin} → forfeit reversed`
            : 'forfeit (prior win reversed)',
          team1Score: fixture.team1Score,
          team2Score: fixture.team2Score,
          team1Overs: fixture.team1Overs || '20.0',
          team2Overs: fixture.team2Overs || '20.0',
          mom: fixture.mom,
          team1Fairness: fixture.team1Fairness || 0,
          team2Fairness: fixture.team2Fairness || 0,
        });
      }
      await saveFixtureResult(payload, { req: options.req });
      succeeded.push({
        fixtureId: fixture._id,
        action,
        team1: fixture.team1,
        team2: fixture.team2,
        newWinner: opponent,
      });
    } catch (err) {
      errors.push({
        fixtureId: fixture._id,
        team1: fixture.team1,
        team2: fixture.team2,
        action,
        message: err.message,
      });
      break;
    }
  }

  if (options.req) {
    emitPointsTableUpdated(options.req, { reason: 'team_forfeit' });
  }

  if (errors.length) {
    const err = new Error(
      `Forfeit partially applied (${succeeded.length}/${toChange.length}). Use Restore to undo, then retry. First failure: ${errors[0].message}`
    );
    err.status = 500;
    err.code = 'PARTIAL_FORFEIT';
    err.succeeded = succeeded;
    err.errors = errors;
    err.snapshotSaved = true;
    throw err;
  }

  return {
    message: `Forfeit applied for ${user.teamName}: ${succeeded.length} fixture(s) updated.`,
    teamName: user.teamName,
    userId: String(user._id),
    updated: succeeded,
    winsReversed: succeeded.filter((s) => s.action === 'flip').length,
    walkovers: succeeded.filter((s) => s.action === 'walkover').length,
  };
}

/**
 * Restore fixtures from the saved forfeit snapshot.
 */
async function restoreTeam(userId, options = {}) {
  const user = await User.findById(userId);
  if (!user) {
    throw Object.assign(new Error('Team not found'), { status: 404 });
  }
  if (!user.leagueForfeit || !user.leagueForfeit.active) {
    throw Object.assign(
      new Error(`${user.teamName || 'Team'} has no active forfeit to restore.`),
      { status: 400, code: 'NO_ACTIVE_FORFEIT' }
    );
  }

  const snapshot = user.leagueForfeit.snapshot || [];
  if (!snapshot.length) {
    user.leagueForfeit = { active: false, forfeitedAt: null, snapshot: [] };
    await user.save();
    throw Object.assign(new Error('Forfeit snapshot was empty; forfeit flag cleared.'), {
      status: 400,
    });
  }

  const succeeded = [];
  const errors = [];

  for (const entry of snapshot) {
    try {
      if (!entry.winner) {
        await clearFixtureResult(entry.fixtureId, { req: options.req });
        succeeded.push({ fixtureId: entry.fixtureId, action: 'cleared' });
      } else {
        const fixture = await Fixture.findById(entry.fixtureId);
        if (!fixture) {
          throw new Error(`Fixture ${entry.fixtureId} no longer exists`);
        }
        const payload = buildFixtureSavePayload(fixture, {
          winner: entry.winner,
          margin: entry.margin,
          team1Score: entry.team1Score,
          team2Score: entry.team2Score,
          team1Overs: entry.team1Overs || '20.0',
          team2Overs: entry.team2Overs || '20.0',
          mom: entry.mom,
          team1Fairness: entry.team1Fairness || 0,
          team2Fairness: entry.team2Fairness || 0,
        });
        await saveFixtureResult(payload, { req: options.req });
        succeeded.push({
          fixtureId: entry.fixtureId,
          action: 'restored',
          winner: entry.winner,
        });
      }
    } catch (err) {
      errors.push({
        fixtureId: entry.fixtureId,
        message: err.message,
      });
      break;
    }
  }

  if (errors.length) {
    const err = new Error(
      `Restore partially applied (${succeeded.length}/${snapshot.length}). First failure: ${errors[0].message}`
    );
    err.status = 500;
    err.code = 'PARTIAL_RESTORE';
    err.succeeded = succeeded;
    err.errors = errors;
    throw err;
  }

  user.leagueForfeit = { active: false, forfeitedAt: null, snapshot: [] };
  await user.save();

  if (options.req) {
    emitPointsTableUpdated(options.req, { reason: 'team_forfeit_restored' });
  }

  return {
    message: `Forfeit restored for ${user.teamName}: ${succeeded.length} fixture(s) reverted.`,
    teamName: user.teamName,
    userId: String(user._id),
    restored: succeeded,
  };
}

module.exports = {
  previewForfeit,
  forfeitTeam,
  restoreTeam,
};
