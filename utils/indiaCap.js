const mongoose = require('mongoose');
const Player = require('../models/Player');
const Bid = require('../models/Bid');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const PickRequest = require('../models/PickRequest');
const BidPlayerQueue = require('../models/BidPlayerQueue');

const isIndiaCountry = (country) =>
  String(country || '')
    .trim()
    .toLowerCase() === 'india';

function extractObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId') return String(value);
    const raw = value._id ?? value.id ?? value.playerId;
    if (raw && raw !== value) return extractObjectId(raw);
  }
  const s = String(value).trim();
  if (/^[a-fA-F0-9]{24}$/.test(s)) return s;
  const match = s.match(/ObjectId\(['"]([a-fA-F0-9]{24})['"]\)/);
  return match ? match[1] : null;
}

function normalizeObjectIds(ids) {
  const unique = [];
  const seen = new Set();
  for (const value of ids || []) {
    const id = extractObjectId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function sanitizeUserPlayerRefs(user) {
  if (!user) return user;
  user.boughtPlayers = normalizeObjectIds(user.boughtPlayers || []);
  user.currentBids = (user.currentBids || [])
    .map((bid) => {
      const playerId = extractObjectId(bid?.playerId);
      if (!playerId) return null;
      return { playerId, amount: bid.amount };
    })
    .filter(Boolean);
  return user;
}

async function countIndianByIds(ids, extraFilter = {}) {
  const unique = normalizeObjectIds(ids);
  if (!unique.length) return 0;
  return Player.countDocuments({
    _id: { $in: unique },
    country: { $regex: /^india$/i },
    ...extraFilter,
  });
}

async function queuedIndianCount(userId, excludePlayerId = null) {
  const uid = String(userId);
  const excl = excludePlayerId ? String(excludePlayerId) : null;
  const docs = await BidPlayerQueue.find({ 'entries.userId': userId })
    .populate('playerId', 'country')
    .lean();

  let count = 0;
  for (const doc of docs) {
    const pid = doc.playerId?._id?.toString() || doc.playerId?.toString();
    if (!pid || (excl && pid === excl)) continue;
    const queued = doc.entries?.some(
      (e) => e.userId.toString() === uid && e.status === 'queued'
    );
    if (queued && isIndiaCountry(doc.playerId?.country)) count += 1;
  }
  return count;
}

function indiaCapMessage({ max, bought, bidding, queued }) {
  const bits = [`${bought} on roster`];
  if (bidding) bits.push(`${bidding} live bid/pick`);
  if (queued) bits.push(`${queued} queued`);
  const total = bought + bidding + queued;
  return `You can have at most ${max} Indian players. You currently have ${bits.join(' + ')} = ${total}. Release an Indian (and wait for pending Indian bids/picks to clear) before adding another.`;
}

async function activeIndianRosterCount(userId, excludePlayerId = null) {
  const excl = excludePlayerId ? String(excludePlayerId) : null;
  const owned = await UserPlayer.find({ userId, isActive: true }).select('playerId').lean();
  const ownedIds = normalizeObjectIds(owned.map((row) => row.playerId)).filter((id) => id !== excl);
  return countIndianByIds(ownedIds, { isSold: true });
}

async function liveIndianBidOrPickCount(userId, excludePlayerId = null) {
  const excl = excludePlayerId ? String(excludePlayerId) : null;
  const [bids, picks] = await Promise.all([
    Bid.find({ bidder: userId, isActive: { $ne: false } }).select('playerId').lean(),
    PickRequest.find({
      user: userId,
      status: { $in: ['pending', 'admin_pending'] },
    })
      .select('player')
      .lean(),
  ]);
  const ids = normalizeObjectIds([
    ...bids.map((b) => b.playerId),
    ...picks.map((p) => p.player),
  ]).filter((id) => id !== excl);
  return countIndianByIds(ids, { isSold: { $ne: true } });
}

async function removeReleasedPlayerRefs(userId, playerId) {
  const user = await User.findById(userId);
  if (!user) return null;
  const pid = extractObjectId(playerId);
  user.boughtPlayers = normalizeObjectIds(user.boughtPlayers || []).filter((id) => id !== pid);
  user.currentBids = (user.currentBids || []).filter(
    (bid) => extractObjectId(bid?.playerId) !== pid
  );
  sanitizeUserPlayerRefs(user);
  await user.save();
  return user;
}

async function assertIndiaCap({
  user,
  player,
  caps,
  alreadyEngaged = false,
  includeQueue = false,
}) {
  if (!player || !isIndiaCountry(player.country)) return { ok: true };
  const playerId = extractObjectId(player._id) || extractObjectId(player);
  if (alreadyEngaged) return { ok: true };

  const max = Number.isFinite(Number(caps?.indiaMax)) ? Number(caps.indiaMax) : 3;
  const bought = await activeIndianRosterCount(user._id, playerId);
  const bidding = await liveIndianBidOrPickCount(user._id, playerId);
  const queued = includeQueue ? await queuedIndianCount(user._id, playerId) : 0;
  const total = bought + bidding + queued;

  if (total >= max) {
    return {
      ok: false,
      status: 400,
      message: indiaCapMessage({ max, bought, bidding, queued }),
    };
  }
  return { ok: true };
}

module.exports = {
  isIndiaCountry,
  assertIndiaCap,
  extractObjectId,
  normalizeObjectIds,
  sanitizeUserPlayerRefs,
  removeReleasedPlayerRefs,
};
