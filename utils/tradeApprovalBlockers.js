const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
const TradeRequest = require('../models/TradeRequest');
const {
  getTradeRules,
  assertPairAllowsCompletion,
  assertBundlePairAllowsCompletion,
  refUserId,
} = require('./tradeRules');
const { getEffectiveTradesUsed } = require('./tradeSlotReservation');
const { isTradeLocked, TRADE_LOCK_HOURS } = require('./tradeApprovalShared');

const TYPE_LIMITS = { Sapphire: 2, Gold: 8, Emerald: 4, Silver: 6 };
const COMBINED_ES_LIMIT = 5;

async function getUserTypeCounts(userId) {
  const ups = await UserPlayer.find({ userId, isActive: true }).populate('playerId', 'type').lean();
  const counts = { Sapphire: 0, Gold: 0, Emerald: 0, Silver: 0 };
  for (const up of ups) {
    const t = up.playerId?.type;
    if (Object.prototype.hasOwnProperty.call(counts, t)) counts[t] += 1;
  }
  return counts;
}

function wouldExceedTypeLimits(counts) {
  for (const [k, v] of Object.entries(TYPE_LIMITS)) {
    if ((counts[k] || 0) > v) return true;
  }
  const es = (counts.Emerald || 0) + (counts.Sapphire || 0);
  if (es > COMBINED_ES_LIMIT) return true;
  return false;
}

function toCr(n) {
  return (Number(n) / 10000000).toFixed(2);
}

/** User.purse is often Decimal128 */
function purseNum(p) {
  if (p == null || p === '') return 0;
  if (typeof p === 'number') return Number.isFinite(p) ? p : 0;
  if (typeof p === 'object' && typeof p.toString === 'function') {
    const x = parseFloat(p.toString());
    return Number.isFinite(x) ? x : 0;
  }
  const x = Number(p);
  return Number.isFinite(x) ? x : 0;
}

function playerIdOf(ref) {
  return ref?._id || ref;
}

/**
 * Shared checks for admin approval. Returns user-facing messages (empty if swap is allowed right now).
 */
async function getTradeApprovalBlockers(tradeDoc) {
  const { blockers } = await computeTradeApproval(tradeDoc);
  return blockers;
}

/**
 * Bundle leg accept — only leg-specific blockers (locks, roster availability).
 * Full purse/type/pair checks run when all legs are accepted (bundle auto-approve).
 */
async function getBundleLegAcceptBlockers(tradeDoc) {
  const blockers = [];
  const offeredPid = playerIdOf(tradeDoc.offeredPlayer);
  const requestedPid = playerIdOf(tradeDoc.requestedPlayer);

  const [offeredUP, requestedUP, offeredPlayer, requestedPlayer] = await Promise.all([
    UserPlayer.findOne({ playerId: offeredPid, isActive: true }),
    UserPlayer.findOne({ playerId: requestedPid, isActive: true }),
    Player.findById(offeredPid),
    Player.findById(requestedPid),
  ]);

  if (!offeredUP || !requestedUP) {
    blockers.push(
      'One or both players are not available for trade (roster may have changed).'
    );
  }

  const lockRule = `Players cannot be traded again for ${TRADE_LOCK_HOURS} hours after a completed trade or after being picked from unsold`;
  if (await isTradeLocked(offeredPlayer)) {
    blockers.push(
      `${offeredPlayer?.name || 'Offered player'} is trade-locked (${lockRule}).`
    );
  }
  if (await isTradeLocked(requestedPlayer)) {
    blockers.push(
      `${requestedPlayer?.name || 'Requested player'} is trade-locked (${lockRule}).`
    );
  }

  return blockers;
}

/**
 * Same as getTradeApprovalBlockers but returns execution payload for admin approve path.
 */
async function validateTradeForAdminApproval(tradeDoc, options = {}) {
  const { bundleBatchApproved = false } = options;
  let result;
  if (bundleBatchApproved) {
    result = await computeSingleTradeApproval(tradeDoc, { skipPairCheck: true });
  } else if (tradeDoc.bundleId) {
    result = await computeBundleTradeApproval(normalizeBundleId(tradeDoc.bundleId), tradeDoc);
  } else {
    result = await computeSingleTradeApproval(tradeDoc);
  }
  const { blockers, execution } = result;
  if (blockers.length) return { ok: false, blockers };
  return { ok: true, ...execution };
}

function normalizeBundleId(ref) {
  return refUserId(ref);
}

async function loadBundleTrades(bundleId) {
  const bid = normalizeBundleId(bundleId);
  return TradeRequest.find({ bundleId: bid })
    .populate('fromUser', 'name teamName purse')
    .populate('toUser', 'name teamName purse')
    .populate('offeredPlayer', 'name type role')
    .populate('requestedPlayer', 'name type role');
}

async function computeBundleTradeApproval(bundleId, focusTrade) {
  const blockers = [];
  const rules = await getTradeRules();
  const trades = await loadBundleTrades(bundleId);
  if (!trades.length) {
    return { blockers: ['Bundle has no trade legs.'], execution: null };
  }

  try {
    await assertBundlePairAllowsCompletion(trades, rules.maxTradesPerOpponentPair);
  } catch (e) {
    if (e.message) blockers.push(e.message);
  }

  const teamState = new Map();
  const legExecutions = [];

  async function ensureTeamState(userDoc) {
    const uid = String(userDoc._id);
    if (!teamState.has(uid)) {
      const [counts, usage] = await Promise.all([
        getUserTypeCounts(userDoc._id),
        getEffectiveTradesUsed(userDoc._id),
      ]);
      teamState.set(uid, {
        user: userDoc,
        typeCounts: { ...counts },
        purse: purseNum(userDoc.purse),
        legsInvolved: 0,
        legsAlreadyReserved: 0,
        usage,
      });
    }
    return teamState.get(uid);
  }

  for (const trade of trades) {
    const offeredPid = playerIdOf(trade.offeredPlayer);
    const requestedPid = playerIdOf(trade.requestedPlayer);

    const [offeredUP, requestedUP, offeredPlayer, requestedPlayer] = await Promise.all([
      UserPlayer.findOne({ playerId: offeredPid, isActive: true }).populate('userId'),
      UserPlayer.findOne({ playerId: requestedPid, isActive: true }).populate('userId'),
      Player.findById(offeredPid),
      Player.findById(requestedPid),
    ]);

    if (!offeredUP || !requestedUP) {
      blockers.push(
        'One or more players are not available for trade (roster may have changed). Refresh and try again.'
      );
      continue;
    }

    const team1 = offeredUP.userId;
    const team2 = requestedUP.userId;
    if (!team1 || !team2) {
      blockers.push('Could not load team data for one of the bundle legs.');
      continue;
    }

    const lockRule = `Players cannot be traded again for ${TRADE_LOCK_HOURS} hours after a completed trade or after being picked from unsold`;
    if (await isTradeLocked(offeredPlayer)) {
      blockers.push(
        `${offeredPlayer?.name || 'A player'} is trade-locked (${lockRule}).`
      );
    }
    if (await isTradeLocked(requestedPlayer)) {
      blockers.push(
        `${requestedPlayer?.name || 'A player'} is trade-locked (${lockRule}).`
      );
    }

    const offeredValue = Number(offeredUP.bidValue || 0);
    const requestedValue = Number(requestedUP.bidValue || 0);

    const t1 = await ensureTeamState(team1);
    const t2 = await ensureTeamState(team2);
    t1.purse += offeredValue - requestedValue;
    t2.purse += requestedValue - offeredValue;
    t1.legsInvolved += 1;
    t2.legsInvolved += 1;
    if (trade.status === 'admin_pending') {
      t1.legsAlreadyReserved += 1;
      t2.legsAlreadyReserved += 1;
    }

    if (offeredPlayer?.type) {
      t1.typeCounts[offeredPlayer.type] = Math.max(0, (t1.typeCounts[offeredPlayer.type] || 0) - 1);
      t2.typeCounts[offeredPlayer.type] = (t2.typeCounts[offeredPlayer.type] || 0) + 1;
    }
    if (requestedPlayer?.type) {
      t1.typeCounts[requestedPlayer.type] = (t1.typeCounts[requestedPlayer.type] || 0) + 1;
      t2.typeCounts[requestedPlayer.type] = Math.max(0, (t2.typeCounts[requestedPlayer.type] || 0) - 1);
    }

    legExecutions.push({
      trade,
      team1,
      team2,
      offeredUP,
      requestedUP,
      offeredPlayer,
      requestedPlayer,
    });
  }

  for (const [, state] of teamState) {
    const name = state.user.teamName || 'A team';
    if (state.purse < 0) {
      blockers.push(
        `${name} would end with a negative purse after all bundle legs (shortfall about ₹${toCr(Math.abs(state.purse))} Cr).`
      );
    }
    if (wouldExceedTypeLimits(state.typeCounts)) {
      blockers.push(
        `After all bundle legs, ${name} would break player-type limits (Sapphire/Emerald/Gold/Silver caps).`
      );
    }
    // admin_pending legs are already in effectiveUsed via reservedSlots — only count legs not yet reserved
    const incrementalSlots = state.legsInvolved - (state.legsAlreadyReserved || 0);
    const projectedUsed = state.usage.effectiveUsed + incrementalSlots;
    if (projectedUsed > rules.tradeSeasonCap) {
      const detail =
        incrementalSlots === 0
          ? `${state.usage.effectiveUsed} effective slots (cap ${rules.tradeSeasonCap})`
          : `${state.usage.effectiveUsed} used + ${incrementalSlots} unreserved leg(s) > ${rules.tradeSeasonCap} cap`;
      blockers.push(`${name} does not have enough season trade slots for this bundle (${detail}).`);
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  if (uniqueBlockers.length) {
    return { blockers: uniqueBlockers, execution: null };
  }

  const focusId = focusTrade?._id ? String(focusTrade._id) : null;
  const focusLeg =
    legExecutions.find((l) => String(l.trade._id) === focusId) || legExecutions[0];

  return {
    blockers: [],
    execution: {
      rules,
      team1: focusLeg.team1,
      team2: focusLeg.team2,
      offeredUP: focusLeg.offeredUP,
      requestedUP: focusLeg.requestedUP,
      offeredPlayer: focusLeg.offeredPlayer,
      requestedPlayer: focusLeg.requestedPlayer,
      newTeam1Purse: teamState.get(String(focusLeg.team1._id))?.purse,
      newTeam2Purse: teamState.get(String(focusLeg.team2._id))?.purse,
      bundleHolistic: true,
    },
  };
}

async function computeSingleTradeApproval(tradeDoc, options = {}) {
  const { skipPairCheck = false } = options;
  const blockers = [];
  const rules = await getTradeRules();

  if (!skipPairCheck) {
    try {
      await assertPairAllowsCompletion(tradeDoc, rules.maxTradesPerOpponentPair);
    } catch (e) {
      if (e.message) blockers.push(e.message);
    }
  }

  const offeredPid = playerIdOf(tradeDoc.offeredPlayer);
  const requestedPid = playerIdOf(tradeDoc.requestedPlayer);

  const [offeredUP, requestedUP] = await Promise.all([
    UserPlayer.findOne({ playerId: offeredPid, isActive: true }).populate('userId'),
    UserPlayer.findOne({ playerId: requestedPid, isActive: true }).populate('userId'),
  ]);

  if (!offeredUP || !requestedUP) {
    blockers.push(
      'One or both players are not available for trade (roster may have changed). Admin cannot approve until this matches your teams.'
    );
    return { blockers, execution: null };
  }

  const team1 = offeredUP.userId;
  const team2 = requestedUP.userId;
  if (!team1 || !team2) {
    blockers.push('Could not load team data for this trade.');
    return { blockers, execution: null };
  }

  const offeredValue = Number(offeredUP.bidValue || 0);
  const requestedValue = Number(requestedUP.bidValue || 0);
  const team1Purse = purseNum(team1.purse);
  const team2Purse = purseNum(team2.purse);
  const newTeam1Purse = team1Purse + offeredValue - requestedValue;
  const newTeam2Purse = team2Purse + requestedValue - offeredValue;

  if (Number.isNaN(newTeam1Purse) || Number.isNaN(newTeam2Purse)) {
    blockers.push('Invalid purse or bid values for trade validation.');
  } else {
    if (newTeam1Purse < 0) {
      const shortfall = Math.abs(newTeam1Purse);
      blockers.push(
        `${team1.teamName || 'Offering team'} would end with a negative purse after the trade (shortfall about ₹${toCr(shortfall)} Cr at current values). Admin will reject unless purses or bid amounts change.`
      );
    }
    if (newTeam2Purse < 0) {
      const shortfall = Math.abs(newTeam2Purse);
      blockers.push(
        `${team2.teamName || 'Other team'} would end with a negative purse after the trade (shortfall about ₹${toCr(shortfall)} Cr at current values). Admin will reject unless purses or bid amounts change.`
      );
    }
  }

  const [offeredPlayer, requestedPlayer] = await Promise.all([
    Player.findById(offeredPid),
    Player.findById(requestedPid),
  ]);

  const lockRule = `Players cannot be traded again for ${TRADE_LOCK_HOURS} hours after a completed trade or after being picked from unsold`;
  if (await isTradeLocked(offeredPlayer)) {
    blockers.push(
      `The offered player is trade-locked (${lockRule}). Admin cannot approve until the lock expires.`
    );
  }
  if (await isTradeLocked(requestedPlayer)) {
    blockers.push(
      `The requested player is trade-locked (${lockRule}). Admin cannot approve until the lock expires.`
    );
  }

  const [team1Counts, team2Counts] = await Promise.all([
    getUserTypeCounts(team1._id),
    getUserTypeCounts(team2._id),
  ]);

  const t1c = { ...team1Counts };
  const t2c = { ...team2Counts };
  if (offeredPlayer?.type) t1c[offeredPlayer.type] = Math.max(0, (t1c[offeredPlayer.type] || 0) - 1);
  if (requestedPlayer?.type) t1c[requestedPlayer.type] = (t1c[requestedPlayer.type] || 0) + 1;
  if (requestedPlayer?.type) t2c[requestedPlayer.type] = Math.max(0, (t2c[requestedPlayer.type] || 0) - 1);
  if (offeredPlayer?.type) t2c[offeredPlayer.type] = (t2c[offeredPlayer.type] || 0) + 1;

  if (wouldExceedTypeLimits(t1c)) {
    blockers.push(
      `After the swap, ${team1.teamName || 'One team'} would break player-type limits (Sapphire/Emerald/Gold/Silver caps).`
    );
  }
  if (wouldExceedTypeLimits(t2c)) {
    blockers.push(
      `After the swap, ${team2.teamName || 'The other team'} would break player-type limits (Sapphire/Emerald/Gold/Silver caps).`
    );
  }

  const [team1Usage, team2Usage] = await Promise.all([
    getEffectiveTradesUsed(team1._id),
    getEffectiveTradesUsed(team2._id),
  ]);
  if (team1Usage.effectiveUsed >= rules.tradeSeasonCap) {
    blockers.push(
      `${team1.teamName || 'One team'} has used all ${rules.tradeSeasonCap} season trade slots (${team1Usage.reservedSlots} reserved by pending deals); cannot approve.`
    );
  }
  if (team2Usage.effectiveUsed >= rules.tradeSeasonCap) {
    blockers.push(
      `${team2.teamName || 'The other team'} has used all ${rules.tradeSeasonCap} season trade slots (${team2Usage.reservedSlots} reserved by pending deals); cannot approve.`
    );
  }

  if (blockers.length) {
    return { blockers, execution: null };
  }

  return {
    blockers: [],
    execution: {
      rules,
      team1,
      team2,
      offeredUP,
      requestedUP,
      offeredPlayer,
      requestedPlayer,
      newTeam1Purse,
      newTeam2Purse,
    },
  };
}

async function computeTradeApproval(tradeDoc) {
  if (tradeDoc.bundleId) {
    return computeBundleTradeApproval(normalizeBundleId(tradeDoc.bundleId), tradeDoc);
  }
  return computeSingleTradeApproval(tradeDoc);
}

module.exports = {
  getTradeApprovalBlockers,
  getBundleLegAcceptBlockers,
  validateTradeForAdminApproval,
  computeBundleTradeApproval,
};
