const User = require('../models/User');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const { isTradeWindowOpen } = require('./tradeRules');
const {
  findUnpairedReleaseForSameTierPick,
  pickIsAlreadyPairedToARelease,
} = require('./releasePickPairing');

const TIERS = ['Sapphire', 'Gold', 'Emerald', 'Silver'];
const PAIR_MAX_MS =
  Number(process.env.TRADE_RELEASE_PICK_PAIR_MAX_MS) || 21 * 24 * 60 * 60 * 1000;

/**
 * Admin sold a player, or released one from the player popup / roster page.
 * Counts only while the trade window is open.
 * Same category release + same category sale/pick is one trade.
 */
async function recordWindowRosterMove({ userId, playerId, playerType, kind }) {
  if (!userId || !playerId || !TIERS.includes(playerType)) return { counted: false };
  if (!(await isTradeWindowOpen())) return { counted: false, reason: 'window-closed' };

  if (kind === 'sale') {
    const pick = await PickRequest.create({
      user: userId,
      player: playerId,
      status: 'completed',
      adminDecision: {
        status: 'approved',
        decidedAt: new Date(),
        note: 'Admin sale during trade window',
      },
    });
    const releasePair = await findUnpairedReleaseForSameTierPick(userId, playerType, pick.createdAt);
    if (releasePair) {
      await ReleaseRequest.findByIdAndUpdate(releasePair._id, {
        $set: { pairedPickRequest: pick._id },
      });
      return { counted: true, charged: false, paired: true };
    }
    await User.findByIdAndUpdate(userId, { $inc: { tradesUsed: 1 } });
    return { counted: true, charged: true, paired: false };
  }

  if (kind === 'release') {
    const release = await ReleaseRequest.create({
      user: userId,
      player: playerId,
      status: 'completed',
      releasedPlayerType: playerType,
      adminDecision: {
        status: 'approved',
        decidedAt: new Date(),
        note: 'Admin release during trade window',
      },
    });
    const recentPick = await findRecentUnpairedSameTierPick(userId, playerType);
    if (recentPick) {
      release.pairedPickRequest = recentPick._id;
      await release.save();
      return { counted: true, charged: false, paired: true };
    }
    await User.findByIdAndUpdate(userId, { $inc: { tradesUsed: 1 } });
    return { counted: true, charged: true, paired: false };
  }

  return { counted: false };
}

async function findRecentUnpairedSameTierPick(userId, playerType) {
  const picks = await PickRequest.find({ user: userId, status: 'completed' })
    .populate('player', 'type')
    .sort({ updatedAt: -1 })
    .limit(40)
    .lean();

  for (const pick of picks) {
    if (pick.player?.type !== playerType) continue;
    const at = pick.updatedAt ? new Date(pick.updatedAt).getTime() : 0;
    if (!at || Date.now() - at > PAIR_MAX_MS) continue;
    if (await pickIsAlreadyPairedToARelease(pick._id)) continue;
    return pick;
  }
  return null;
}

module.exports = { recordWindowRosterMove };
