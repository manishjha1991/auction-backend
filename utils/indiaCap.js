const Player = require('../models/Player');
const BidPlayerQueue = require('../models/BidPlayerQueue');

const isIndiaCountry = (country) =>
  String(country || '')
    .trim()
    .toLowerCase() === 'india';

async function countIndianByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean).map((id) => String(id)))];
  if (!unique.length) return 0;
  return Player.countDocuments({
    _id: { $in: unique },
    country: { $regex: /^india$/i },
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
  const bits = [`${bought} bought`];
  if (bidding) bits.push(`${bidding} currently bidding`);
  if (queued) bits.push(`${queued} queued`);
  const total = bought + bidding + queued;
  return `You can have at most ${max} Indian players across all categories. You already have ${bits.join(' + ')} = ${total}. You cannot bid on a 4th Indian player.`;
}

async function assertIndiaCap({
  user,
  player,
  caps,
  alreadyEngaged = false,
  includeQueue = false,
}) {
  if (!player || !isIndiaCountry(player.country)) return { ok: true };
  if (alreadyEngaged) return { ok: true };

  const max = Number.isFinite(Number(caps?.indiaMax)) ? Number(caps.indiaMax) : 3;
  const bought = await countIndianByIds(user.boughtPlayers || []);
  const bidding = await countIndianByIds(
    (user.currentBids || []).map((bid) => bid.playerId)
  );
  const queued = includeQueue ? await queuedIndianCount(user._id, player._id) : 0;
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
};
