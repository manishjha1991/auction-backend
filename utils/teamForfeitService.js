/**
 * Admin one-click league forfeit / restore for a team.
 *
 * Forfeit:
 * - Real losses: leave unchanged
 * - Real wins: give to opponent (scores kept for restore)
 * - Unplayed: walkover to opponent (0 runs / 0.0–0.1 overs)
 * - Opponent also forfeited: leave / clear to not played (mutual)
 *
 * Restore:
 * - Snapshot: put real wins back; clear prior-unplayed walkovers
 * - Mutual H2H: stay not played
 * - Also clear any 0-run / walkover-margin losses (manual walkovers)
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

function parseRuns(score) {
  if (!score || typeof score !== 'string') return null;
  const m = String(score).trim().match(/^(\d+)\s*\/\s*\d+$/);
  return m ? Number(m[1]) : null;
}

/** Detect walkover-style results (tool walkovers use 0 runs + 0.0/0.1 overs). */
function isWalkoverPattern(fixture) {
  if (!fixture || !fixture.winner) return false;
  const margin = String(fixture.margin || '');
  if (/walkover|forfeit/i.test(margin)) return true;

  const o1 = String(fixture.team1Overs || '').trim();
  const o2 = String(fixture.team2Overs || '').trim();
  if ((o1 === '0.0' && o2 === '0.1') || (o1 === '0.1' && o2 === '0.0')) return true;

  const r1 = parseRuns(fixture.team1Score);
  const r2 = parseRuns(fixture.team2Score);
  if (r1 === 0 && r2 === 1) return true;
  if (r1 === 1 && r2 === 0) return true;
  // Legacy admin stubs: both sides 0/0 (often with 20.0 overs + fairness)
  if (r1 === 0 && r2 === 0) return true;
  return false;
}

/**
 * Heuristic: fixture looks like it was actually played (not admin bulk walkover).
 * Real games have meaningful runs (not 0/0). Fairness alone is NOT enough —
 * legacy walkovers often set fairness with 0/0 scores.
 */
function isLikelyRealPlayedMatch(fixture) {
  if (!fixture || !fixture.winner) return false;
  if (isWalkoverPattern(fixture)) return false;

  const r1 = parseRuns(fixture.team1Score);
  const r2 = parseRuns(fixture.team2Score);
  const maxRuns = Math.max(r1 == null ? 0 : r1, r2 == null ? 0 : r2);
  // No real runs → not a played match
  if (maxRuns < 10) return false;

  if (fixture.mom?.name && String(fixture.mom.name).trim()) return true;

  const o1 = parseFloat(String(fixture.team1Overs || '').trim());
  const o2 = parseFloat(String(fixture.team2Overs || '').trim());
  const maxOvers = Math.max(Number.isFinite(o1) ? o1 : 0, Number.isFinite(o2) ? o2 : 0);

  if (maxOvers >= 5 && maxRuns >= 15) return true;
  if (maxOvers >= 8 && maxRuns >= 10) return true;
  return false;
}

function lossReasonMeta(fixture) {
  const reasons = [];
  if (fixture.mom?.name && String(fixture.mom.name).trim()) reasons.push('MoM set');
  if ((Number(fixture.team1Fairness) || 0) > 0 || (Number(fixture.team2Fairness) || 0) > 0) {
    reasons.push('fairness');
  }
  const r1 = parseRuns(fixture.team1Score);
  const r2 = parseRuns(fixture.team2Score);
  const o1 = String(fixture.team1Overs || '').trim();
  const o2 = String(fixture.team2Overs || '').trim();
  if (r1 != null || r2 != null) reasons.push(`scores ${fixture.team1Score || '-'} / ${fixture.team2Score || '-'}`);
  if (o1 || o2) reasons.push(`overs ${o1 || '-'} / ${o2 || '-'}`);
  return reasons.join(', ') || 'no match details';
}

function snapshotFromFixture(fixture, extra = {}) {
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
    restoreAction: extra.restoreAction || (fixture.winner ? 'restoreWinner' : 'clear'),
  };
}

function teamWonFixture(fixture, teamUserId) {
  if (!fixture.winner || !teamUserId) return false;
  const winnerUserId = resolveWinnerUserId(fixture.winner, fixture);
  if (winnerUserId) return String(winnerUserId) === String(teamUserId);
  return false;
}

function teamLostFixture(fixture, teamUserId) {
  return !!(fixture.winner && !teamWonFixture(fixture, teamUserId));
}

function opponentName(fixture, teamUserId) {
  if (fixture.team1UserId && String(fixture.team1UserId) === String(teamUserId)) {
    return fixture.team2;
  }
  return fixture.team1;
}

function opponentUserId(fixture, teamUserId) {
  if (fixture.team1UserId && String(fixture.team1UserId) === String(teamUserId)) {
    return fixture.team2UserId;
  }
  return fixture.team1UserId;
}

function isTeam1Side(fixture, teamUserId) {
  return fixture.team1UserId && String(fixture.team1UserId) === String(teamUserId);
}

function walkoverPayload(fixture, opponentWinnerName, forfeitingUserId) {
  const forfeiterIsTeam1 = isTeam1Side(fixture, forfeitingUserId);
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

async function loadForfeitActiveUserIdSet(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map((id) => String(id)))];
  if (!ids.length) return new Set();
  const users = await User.find({
    _id: { $in: ids },
    'leagueForfeit.active': true,
  })
    .select('_id')
    .lean();
  return new Set(users.map((u) => String(u._id)));
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

function classifyForfeitActions(fixtures, userId, opponentForfeitIds) {
  const winsToReverse = [];
  const remainingWalkovers = [];
  const alreadyLostReal = []; // truly played losses — never auto-clear
  const alreadyLostLikelyManual = []; // admin bulk losses — clear on restore by default
  const alreadyLostWalkover = [];
  const mutualUnplayed = [];
  const toChange = [];

  for (const fixture of fixtures) {
    const oppId = opponentUserId(fixture, userId);
    const oppForfeited = oppId && opponentForfeitIds.has(String(oppId));
    const base = {
      fixtureId: fixture._id,
      team1: fixture.team1,
      team2: fixture.team2,
      opponent: opponentName(fixture, userId),
      detail: lossReasonMeta(fixture),
    };

    if (oppForfeited) {
      mutualUnplayed.push(base);
      if (fixture.winner) {
        toChange.push({
          fixture,
          action: 'mutualClear',
          snap: snapshotFromFixture(fixture, { restoreAction: 'leaveUnplayed' }),
        });
      } else {
        toChange.push({
          fixture,
          action: 'mutualSkip',
          snap: snapshotFromFixture(fixture, { restoreAction: 'leaveUnplayed' }),
        });
      }
      continue;
    }

    if (!fixture.winner) {
      remainingWalkovers.push(base);
      toChange.push({
        fixture,
        action: 'walkover',
        snap: snapshotFromFixture(fixture, { restoreAction: 'clear' }),
      });
    } else if (teamWonFixture(fixture, userId)) {
      winsToReverse.push(base);
      toChange.push({
        fixture,
        action: 'flip',
        snap: snapshotFromFixture(fixture, { restoreAction: 'restoreWinner' }),
      });
    } else if (isWalkoverPattern(fixture)) {
      alreadyLostWalkover.push(base);
      toChange.push({
        fixture,
        action: 'walkoverLossKeep',
        snap: snapshotFromFixture(fixture, { restoreAction: 'clear' }),
      });
    } else if (isLikelyRealPlayedMatch(fixture)) {
      alreadyLostReal.push(base);
    } else {
      alreadyLostLikelyManual.push(base);
      toChange.push({
        fixture,
        action: 'walkoverLossKeep',
        snap: snapshotFromFixture(fixture, { restoreAction: 'clear' }),
      });
    }
  }

  return {
    winsToReverse,
    remainingWalkovers,
    alreadyLostReal,
    alreadyLostLikelyManual,
    alreadyLostWalkover,
    mutualUnplayed,
    toChange,
  };
}

/**
 * Preview what forfeit / restore would change (no mutations).
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
  const oppIds = fixtures.map((f) => opponentUserId(f, userId));
  const opponentForfeitIds = await loadForfeitActiveUserIdSet(oppIds);
  const classified = classifyForfeitActions(fixtures, userId, opponentForfeitIds);

  const walkoverLossesToClearOnRestore = fixtures
    .filter((f) => teamLostFixture(f, userId) && isWalkoverPattern(f))
    .map((f) => ({
      fixtureId: f._id,
      team1: f.team1,
      team2: f.team2,
      opponent: opponentName(f, userId),
      detail: lossReasonMeta(f),
    }));

  const snapshot = user.leagueForfeit?.snapshot || [];
  const forfeitActive = !!(user.leagueForfeit && user.leagueForfeit.active);

  const mutableOnForfeit = classified.toChange.filter(
    (c) => c.action !== 'mutualSkip' && c.action !== 'walkoverLossKeep'
  );

  const suggestedManualClearIds = classified.alreadyLostLikelyManual.map((f) =>
    String(f.fixtureId)
  );

  return {
    userId: String(user._id),
    teamName: user.teamName,
    forfeitActive,
    forfeitedAt: user.leagueForfeit?.forfeitedAt || null,
    snapshotCount: snapshot.length,
    winsToReverseCount: classified.winsToReverse.length,
    remainingWalkoversCount: classified.remainingWalkovers.length,
    alreadyLostRealCount: classified.alreadyLostReal.length,
    alreadyLostLikelyManualCount: classified.alreadyLostLikelyManual.length,
    alreadyLostWalkoverCount: classified.alreadyLostWalkover.length,
    mutualUnplayedCount: classified.mutualUnplayed.length,
    winsToReverse: classified.winsToReverse,
    remainingWalkovers: classified.remainingWalkovers,
    alreadyLostReal: classified.alreadyLostReal,
    alreadyLostLikelyManual: classified.alreadyLostLikelyManual,
    alreadyLostWalkover: classified.alreadyLostWalkover,
    mutualUnplayed: classified.mutualUnplayed,
    totalAffected: mutableOnForfeit.length,
    canRestore:
      forfeitActive ||
      walkoverLossesToClearOnRestore.length > 0 ||
      classified.alreadyLostLikelyManual.length > 0,
    walkoverLossesToClearOnRestore,
    walkoverLossesToClearCount: walkoverLossesToClearOnRestore.length,
    suggestedManualClearIds,
    alreadyLostCount:
      classified.alreadyLostReal.length +
      classified.alreadyLostLikelyManual.length +
      classified.alreadyLostWalkover.length,
    alreadyLost: [
      ...classified.alreadyLostReal,
      ...classified.alreadyLostLikelyManual,
      ...classified.alreadyLostWalkover,
    ],
  };
}

/**
 * Forfeit: snapshot then apply walkovers / flip wins / mutual clear.
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
  for (const fixture of fixtures) {
    if (!fixture.team1UserId || !fixture.team2UserId) {
      throw Object.assign(
        new Error(
          `Fixture "${fixture.team1} vs ${fixture.team2}" is missing team user IDs. Fix the fixture before forfeiting.`
        ),
        { status: 400 }
      );
    }
  }

  const oppIds = fixtures.map((f) => opponentUserId(f, userId));
  const opponentForfeitIds = await loadForfeitActiveUserIdSet(oppIds);
  const classified = classifyForfeitActions(fixtures, userId, opponentForfeitIds);
  const toChange = classified.toChange;

  const needsWork = toChange.some(
    (c) => c.action === 'walkover' || c.action === 'flip' || c.action === 'mutualClear'
  );
  if (!needsWork && !toChange.some((c) => c.action === 'walkoverLossKeep' || c.action === 'mutualSkip')) {
    throw Object.assign(
      new Error('Nothing to forfeit: no wins to reverse and no remaining unplayed fixtures.'),
      { status: 400 }
    );
  }
  if (!needsWork && toChange.every((c) => c.action === 'walkoverLossKeep' || c.action === 'mutualSkip')) {
    // Still mark forfeited + snapshot so Restore can clear walkover losses / mutual later
  }

  const applyIds = toChange
    .filter((c) => c.action === 'walkover' || c.action === 'flip' || c.action === 'mutualClear')
    .map((c) => c.fixture._id);
  await assertNoPendingSubmissions(applyIds);

  const snapshot = toChange.map((c) => c.snap);
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
      if (action === 'mutualSkip' || action === 'walkoverLossKeep') {
        succeeded.push({
          fixtureId: fixture._id,
          action,
          team1: fixture.team1,
          team2: fixture.team2,
        });
        continue;
      }
      if (action === 'mutualClear') {
        await clearFixtureResult(fixture._id, { req: options.req });
        succeeded.push({
          fixtureId: fixture._id,
          action,
          team1: fixture.team1,
          team2: fixture.team2,
          newWinner: null,
        });
        continue;
      }
      let payload;
      if (action === 'walkover') {
        payload = walkoverPayload(fixture, opponent, userId);
      } else {
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
    message: `Forfeit applied for ${user.teamName}: ${succeeded.length} fixture(s) processed.`,
    teamName: user.teamName,
    userId: String(user._id),
    updated: succeeded,
    winsReversed: succeeded.filter((s) => s.action === 'flip').length,
    walkovers: succeeded.filter((s) => s.action === 'walkover').length,
    mutualLeftUnplayed: succeeded.filter(
      (s) => s.action === 'mutualClear' || s.action === 'mutualSkip'
    ).length,
  };
}

/**
 * Restore: snapshot first, then clear 0-run walkovers, then any extra clearFixtureIds
 * (manual walkovers that don't use 0-run scores).
 * @param {string} userId
 * @param {object} [options]
 * @param {import('express').Request} [options.req]
 * @param {string[]} [options.clearFixtureIds] Extra fixture IDs to clear (manual walkovers)
 */
async function restoreTeam(userId, options = {}) {
  const user = await User.findById(userId);
  if (!user) {
    throw Object.assign(new Error('Team not found'), { status: 404 });
  }

  const snapshot = (user.leagueForfeit && user.leagueForfeit.snapshot) || [];
  const forfeitActive = !!(user.leagueForfeit && user.leagueForfeit.active);
  const extraClearIds = new Set(
    (options.clearFixtureIds || []).map((id) => String(id)).filter(Boolean)
  );

  const fixtures = await loadTeamFixtures(userId);
  const walkoverLosses = fixtures.filter(
    (f) => teamLostFixture(f, userId) && isWalkoverPattern(f)
  );

  if (
    !forfeitActive &&
    !snapshot.length &&
    !walkoverLosses.length &&
    !extraClearIds.size
  ) {
    throw Object.assign(
      new Error(
        `${user.teamName || 'Team'} has nothing to restore (no forfeit snapshot, no 0-run walkovers, and no selected losses).`
      ),
      { status: 400, code: 'NOTHING_TO_RESTORE' }
    );
  }

  const succeeded = [];
  const errors = [];
  const handledIds = new Set();

  for (const entry of snapshot) {
    try {
      const id = String(entry.fixtureId);
      handledIds.add(id);
      const leaveUnplayed =
        entry.restoreAction === 'leaveUnplayed' ||
        entry.restoreAction === 'clear' ||
        !entry.winner;

      if (leaveUnplayed) {
        await clearFixtureResult(entry.fixtureId, { req: options.req });
        succeeded.push({ fixtureId: entry.fixtureId, action: 'cleared' });
      } else {
        const fixture = await Fixture.findById(entry.fixtureId);
        if (!fixture) {
          throw new Error(`Fixture ${entry.fixtureId} no longer exists`);
        }
        const oppId = opponentUserId(fixture, userId);
        const oppStillForfeit = oppId
          ? !!(await User.findById(oppId).select('leagueForfeit').lean())?.leagueForfeit
              ?.active
          : false;

        if (oppStillForfeit) {
          await clearFixtureResult(entry.fixtureId, { req: options.req });
          succeeded.push({
            fixtureId: entry.fixtureId,
            action: 'leftUnplayedMutual',
          });
        } else {
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
      }
    } catch (err) {
      errors.push({ fixtureId: entry.fixtureId, message: err.message });
      break;
    }
  }

  if (!errors.length) {
    const fresh = await loadTeamFixtures(userId);
    for (const fixture of fresh) {
      const id = String(fixture._id);
      if (handledIds.has(id)) continue;

      const isAutoWalkover = teamLostFixture(fixture, userId) && isWalkoverPattern(fixture);
      const isManualSelected = extraClearIds.has(id) && teamLostFixture(fixture, userId);
      // Never clear a real played loss (MoM / fairness / real overs) — even if checked
      if (isManualSelected && isLikelyRealPlayedMatch(fixture)) {
        succeeded.push({
          fixtureId: fixture._id,
          action: 'skippedRealPlayedLoss',
        });
        handledIds.add(id);
        continue;
      }
      if (!isAutoWalkover && !isManualSelected) continue;

      try {
        await clearFixtureResult(fixture._id, { req: options.req });
        succeeded.push({
          fixtureId: fixture._id,
          action: isManualSelected ? 'clearedManualWalkover' : 'clearedWalkover',
        });
        handledIds.add(id);
      } catch (err) {
        errors.push({ fixtureId: fixture._id, message: err.message });
        break;
      }
    }
  }

  if (errors.length) {
    const err = new Error(
      `Restore partially applied (${succeeded.length}). First failure: ${errors[0].message}`
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
    message: `Restored ${user.teamName}: ${succeeded.length} fixture(s) updated. Real losses you left unchecked were kept.`,
    teamName: user.teamName,
    userId: String(user._id),
    restored: succeeded,
  };
}

module.exports = {
  previewForfeit,
  forfeitTeam,
  restoreTeam,
  isWalkoverPattern,
  isLikelyRealPlayedMatch,
};
