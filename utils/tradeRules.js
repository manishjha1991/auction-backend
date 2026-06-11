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
  if (typeof id === 'object' && id._id != null) return toObjectId(id._id);
  if (typeof id === 'object' && id.id != null) return toObjectId(id.id);
  if (typeof id === 'object' && id.$oid != null) return toObjectId(id.$oid);
  const s = String(id).trim();
  if (!mongoose.Types.ObjectId.isValid(s) || s.length !== 24) return null;
  return new mongoose.Types.ObjectId(s);
}

/** Resolve user id from ObjectId, populated user doc, or string. */
function refUserId(ref) {
  if (ref == null) return null;
  if (ref instanceof mongoose.Types.ObjectId) return ref;
  if (typeof ref === 'object') {
    if (ref._id != null) return refUserId(ref._id);
    if (ref.id != null) return refUserId(ref.id);
    if (ref.$oid != null) return refUserId(ref.$oid);
  }
  return toObjectId(ref);
}

function pairOrClause(userIdA, userIdB) {
  const a = refUserId(userIdA);
  const b = refUserId(userIdB);
  if (!a || !b) return null;
  return [{ fromUser: a, toUser: b }, { fromUser: b, toUser: a }];
}

const ACTIVE_TRADE_STATUSES = ['pending', 'counter', 'admin_pending'];

/** Active deals between two teams — bundle legs count as one deal, not one per leg. */
async function countActiveDealsBetweenTeams(userIdA, userIdB) {
  const or = pairOrClause(userIdA, userIdB);
  if (!or) return 0;
  const activeTrades = await TradeRequest.find({
    $or: or,
    status: { $in: ACTIVE_TRADE_STATUSES },
  })
    .select('bundleId')
    .lean();
  const bundleDeals = new Set();
  let standalone = 0;
  for (const t of activeTrades) {
    if (t.bundleId) bundleDeals.add(String(t.bundleId));
    else standalone += 1;
  }
  return standalone + bundleDeals.size;
}

/** Completed + active between two teams (active uses bundle-aware deal counting). */
async function countTradesBetweenTeams(userIdA, userIdB) {
  const or = pairOrClause(userIdA, userIdB);
  if (!or) return { completed: 0, active: 0, total: 0 };
  const [completed, activeDeals] = await Promise.all([
    TradeRequest.countDocuments({ $or: or, status: 'completed' }),
    countActiveDealsBetweenTeams(userIdA, userIdB),
  ]);
  return { completed, active: activeDeals, total: completed + activeDeals };
}

/**
 * Before creating a new proposal: room for one more active doc between this pair.
 */
async function assertPairAllowsNewProposal(fromUserId, toUserId, maxTradesPerOpponentPair, bundleId = null) {
  const { completed, active } = await countTradesBetweenTeams(fromUserId, toUserId);
  let effectiveActive = active;

  if (bundleId) {
    const bid = refUserId(bundleId) || bundleId;
    const or = pairOrClause(fromUserId, toUserId);
    const bundleHasLeg = or
      ? await TradeRequest.exists({
          bundleId: bid,
          $or: or,
          status: { $in: ACTIVE_TRADE_STATUSES },
        })
      : null;
    if (bundleHasLeg) {
      effectiveActive = Math.max(0, active - 1);
    }
  }

  if (completed + effectiveActive >= maxTradesPerOpponentPair) {
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
  const fromId = refUserId(tradeDoc?.fromUser);
  const toId = refUserId(tradeDoc?.toUser);
  const or = pairOrClause(fromId, toId);
  if (!or) {
    const err = new Error('Invalid trade parties for pair limit check.');
    err.statusCode = 400;
    throw err;
  }
  const [completed, activeDeals] = await Promise.all([
    TradeRequest.countDocuments({ $or: or, status: 'completed' }),
    countActiveDealsBetweenTeams(fromId, toId),
  ]);
  if (completed + activeDeals > maxTradesPerOpponentPair) {
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

/**
 * Bundle legs between the same two teams count as one opponent-pair deal.
 */
async function assertBundlePairAllowsCompletion(trades, maxTradesPerOpponentPair) {
  if (!trades?.length) return;
  const fromId = refUserId(trades[0].fromUser);
  const toId = refUserId(trades[0].toUser);
  if (!fromId || !toId) {
    const err = new Error('Invalid trade parties for pair limit check.');
    err.statusCode = 400;
    throw err;
  }
  for (const t of trades) {
    const f = refUserId(t.fromUser);
    const u = refUserId(t.toUser);
    if (!f || !u) {
      const err = new Error('Invalid trade parties for pair limit check.');
      err.statusCode = 400;
      throw err;
    }
  }
  const or = pairOrClause(fromId, toId);
  const [completed, activeDeals] = await Promise.all([
    TradeRequest.countDocuments({ $or: or, status: 'completed' }),
    countActiveDealsBetweenTeams(fromId, toId),
  ]);
  if (completed + activeDeals > maxTradesPerOpponentPair) {
    const err = new Error(
      `This bundle would exceed the limit of ${maxTradesPerOpponentPair} deal(s) between these teams this season.`
    );
    err.statusCode = 400;
    throw err;
  }
}

module.exports = {
  RULE_MIN,
  RULE_MAX,
  DEFAULT_TRADE_SEASON_CAP,
  DEFAULT_MAX_TRADES_PER_OPPONENT_PAIR,
  getTradeRules,
  refUserId,
  countTradesBetweenTeams,
  countActiveDealsBetweenTeams,
  assertPairAllowsNewProposal,
  assertPairAllowsCompletion,
  assertBundlePairAllowsCompletion,
};
