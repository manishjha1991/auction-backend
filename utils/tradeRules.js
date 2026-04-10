const mongoose = require('mongoose');
const AppSettings = require('../models/AppSettings');
const TradeRequest = require('../models/TradeRequest');

const RULE_MIN = 1;
const RULE_MAX = 10;
const DEFAULT_TRADE_SEASON_CAP = 3;
const DEFAULT_MAX_TRADES_PER_OPPONENT_PAIR = 1;

function clampRuleInt(n, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(RULE_MAX, Math.max(RULE_MIN, Math.floor(x)));
}

/**
 * Season trade cap, per-opponent-pair cap, and max concurrent outgoing trade proposals.
 * Outgoing limit tracks season cap so one admin knob controls both.
 */
async function getTradeRules() {
  const doc = await AppSettings.findOne()
    .select('tradeSeasonCap maxTradesPerOpponentPair')
    .lean();
  const tradeSeasonCap = clampRuleInt(doc?.tradeSeasonCap, DEFAULT_TRADE_SEASON_CAP);
  const maxTradesPerOpponentPair = clampRuleInt(
    doc?.maxTradesPerOpponentPair,
    DEFAULT_MAX_TRADES_PER_OPPONENT_PAIR
  );
  return {
    tradeSeasonCap,
    maxTradesPerOpponentPair,
    maxActiveOutgoingTrades: tradeSeasonCap,
  };
}

function toObjectId(id) {
  if (id == null) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function pairOrClause(userIdA, userIdB) {
  const a = toObjectId(userIdA);
  const b = toObjectId(userIdB);
  if (!a || !b) return null;
  return [{ fromUser: a, toUser: b }, { fromUser: b, toUser: a }];
}

/** Completed + active (pending / counter / admin_pending) between two teams, either direction. */
async function countTradesBetweenTeams(userIdA, userIdB) {
  const or = pairOrClause(userIdA, userIdB);
  if (!or) return { completed: 0, active: 0, total: 0 };
  const [completed, active] = await Promise.all([
    TradeRequest.countDocuments({ $or: or, status: 'completed' }),
    TradeRequest.countDocuments({
      $or: or,
      status: { $in: ['pending', 'counter', 'admin_pending'] },
    }),
  ]);
  return { completed, active, total: completed + active };
}

/**
 * Before creating a new proposal: room for one more active doc between this pair.
 */
async function assertPairAllowsNewProposal(fromUserId, toUserId, maxTradesPerOpponentPair) {
  const { completed, active } = await countTradesBetweenTeams(fromUserId, toUserId);
  if (completed + active >= maxTradesPerOpponentPair) {
    const err = new Error(
      `These teams have reached the limit of ${maxTradesPerOpponentPair} trade deal(s) between them this season (including pending).`
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Before admin approves: invariant completed + active (incl. this trade) <= pair cap.
 */
async function assertPairAllowsCompletion(tradeDoc, maxTradesPerOpponentPair) {
  const or = pairOrClause(tradeDoc.fromUser, tradeDoc.toUser);
  if (!or) {
    const err = new Error('Invalid trade parties for pair limit check.');
    err.statusCode = 400;
    throw err;
  }
  const [completed, active] = await Promise.all([
    TradeRequest.countDocuments({ $or: or, status: 'completed' }),
    TradeRequest.countDocuments({
      $or: or,
      status: { $in: ['pending', 'counter', 'admin_pending'] },
    }),
  ]);
  if (completed + active > maxTradesPerOpponentPair) {
    const err = new Error(
      `This trade would exceed the limit of ${maxTradesPerOpponentPair} deal(s) between these teams this season.`
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Season slot (`User.tradesUsed`) — MSD vs BLU–style accounting:
 * - Completed player trade (any categories): +1 per team (routes/trades.js). One deal = one slot per side.
 * - Approved release: +1 (routes/releases.js). Example: MSD drops surplus Gold after a swap → another slot.
 * - Approved unsold pick: +1 (routes/picks.js) unless it pairs to a completed release whose `releasedPlayerType` matches the picked player’s type → pick adds no extra (release already +1).
 * - Different-tier release + pick (e.g. release Sapphire, pick Gold): no pair → +1 release +1 pick.
 * - Same-tier release + same-tier unsold pick: one slot total (ReleaseRequest.pairedPickRequest).
 *
 * Minimum roster by category (Gold/Silver/Sapphire+Emerald) is enforced elsewhere (e.g. lock-under-limit in
 * bidRoutes.js); release/pick should be used so teams can satisfy those mins — slot counting follows the rules above.
 */

module.exports = {
  RULE_MIN,
  RULE_MAX,
  DEFAULT_TRADE_SEASON_CAP,
  DEFAULT_MAX_TRADES_PER_OPPONENT_PAIR,
  getTradeRules,
  countTradesBetweenTeams,
  assertPairAllowsNewProposal,
  assertPairAllowsCompletion,
};
