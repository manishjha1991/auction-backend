const mongoose = require('mongoose');
const TradeRequest = require('../models/TradeRequest');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const User = require('../models/User');
const { clampTradesUsed } = require('./tradeConstants');
const { getTradeRules } = require('./tradeRules');

function toObjectId(id) {
  if (id == null) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

async function countReservedTradeSlots(userId) {
  const uid = toObjectId(userId);
  if (!uid) return 0;
  return TradeRequest.countDocuments({
    status: 'admin_pending',
    $or: [{ fromUser: uid }, { toUser: uid }],
  });
}

async function countReservedReleaseSlots(userId) {
  const uid = toObjectId(userId);
  if (!uid) return 0;
  return ReleaseRequest.countDocuments({
    user: uid,
    status: { $in: ['pending', 'admin_pending'] },
  });
}

async function countReservedPickSlots(userId) {
  const uid = toObjectId(userId);
  if (!uid) return 0;
  return PickRequest.countDocuments({
    user: uid,
    status: { $in: ['pending', 'admin_pending'] },
  });
}

async function getReservedSlotCount(userId) {
  const [trades, releases, picks] = await Promise.all([
    countReservedTradeSlots(userId),
    countReservedReleaseSlots(userId),
    countReservedPickSlots(userId),
  ]);
  return trades + releases + picks;
}

async function getEffectiveTradesUsed(userId) {
  const user = await User.findById(userId).select('tradesUsed').lean();
  const used = clampTradesUsed(user?.tradesUsed);
  const reserved = await getReservedSlotCount(userId);
  return { tradesUsed: used, reservedSlots: reserved, effectiveUsed: used + reserved };
}

async function assertHasTradeSlotRemaining(userId, rules = null) {
  const r = rules || (await getTradeRules());
  const { effectiveUsed } = await getEffectiveTradesUsed(userId);
  if (effectiveUsed >= r.tradeSeasonCap) {
    const err = new Error(
      `Season trade cap reached (${effectiveUsed}/${r.tradeSeasonCap} including pending reservations). Complete or withdraw pending deals before starting another.`
    );
    err.statusCode = 400;
    throw err;
  }
}

async function getTradeUsageSummary(userId) {
  const rules = await getTradeRules();
  const { tradesUsed, reservedSlots, effectiveUsed } = await getEffectiveTradesUsed(userId);
  const cap = rules.tradeSeasonCap;
  return {
    tradesUsed,
    reservedSlots,
    effectiveUsed,
    cap,
    remaining: Math.max(0, cap - effectiveUsed),
    maxActiveOutgoing: rules.maxActiveOutgoingTrades,
    maxTradesPerOpponentPair: rules.maxTradesPerOpponentPair,
  };
}

module.exports = {
  countReservedTradeSlots,
  countReservedReleaseSlots,
  countReservedPickSlots,
  getReservedSlotCount,
  getEffectiveTradesUsed,
  assertHasTradeSlotRemaining,
  getTradeUsageSummary,
};
