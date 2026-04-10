const mongoose = require('mongoose');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');

const TIERS = ['Sapphire', 'Gold', 'Emerald', 'Silver'];

function unpairedReleaseFilter() {
  return {
    $or: [
      { pairedPickRequest: null },
      { pairedPickRequest: { $exists: false } },
    ],
  };
}

async function pickIsAlreadyPairedToARelease(pickId) {
  return ReleaseRequest.exists({ pairedPickRequest: pickId });
}

/**
 * Completed release (same user) that can pair with an unsold pick of pickPlayerType.
 * Prefers `releasedPlayerType`; falls back to tier of the released Player for legacy rows.
 */
async function findUnpairedReleaseForSameTierPick(userId, pickPlayerType) {
  if (!TIERS.includes(pickPlayerType)) return null;
  const uid = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const explicit = await ReleaseRequest.findOne({
    user: uid,
    status: 'completed',
    releasedPlayerType: pickPlayerType,
    ...unpairedReleaseFilter(),
  }).sort({ updatedAt: -1 });
  if (explicit) return explicit;

  const legacy = await ReleaseRequest.aggregate([
    {
      $match: {
        user: uid,
        status: 'completed',
        ...unpairedReleaseFilter(),
        $or: [
          { releasedPlayerType: { $exists: false } },
          { releasedPlayerType: null },
          { releasedPlayerType: '' },
        ],
      },
    },
    {
      $lookup: {
        from: 'players',
        localField: 'player',
        foreignField: '_id',
        as: 'rp',
      },
    },
    { $match: { 'rp.type': pickPlayerType } },
    { $sort: { updatedAt: -1 } },
    { $limit: 1 },
  ]);
  if (!legacy.length) return null;
  return ReleaseRequest.findById(legacy[0]._id);
}

/**
 * If admin approved a same-tier unsold pick before this release, the pick already consumed +1.
 * Link the pair and skip the release's +1 so the duo still costs one slot total.
 * Prefers picks completed after the release request was created; if none, uses the only
 * unpaired completed pick of that tier (safe when there is exactly one).
 */
async function findOrphanPickToPairOnReleaseApprove(releaseMongooseDoc, releasedPlayerType) {
  if (!TIERS.includes(releasedPlayerType)) return null;
  const userId = releaseMongooseDoc.user;
  const since = releaseMongooseDoc.createdAt || new Date(0);

  const allForUser = await PickRequest.find({
    user: userId,
    status: 'completed',
  })
    .populate('player', 'type')
    .sort({ updatedAt: -1 })
    .lean();

  const unpairedSameTier = [];
  for (const pr of allForUser) {
    if (pr.player?.type !== releasedPlayerType) continue;
    if (await pickIsAlreadyPairedToARelease(pr._id)) continue;
    unpairedSameTier.push(pr);
  }

  const afterRequest = unpairedSameTier.filter((pr) => {
    const t = pr.updatedAt ? new Date(pr.updatedAt).getTime() : 0;
    return t >= since.getTime();
  });
  if (afterRequest.length === 1) return afterRequest[0];
  if (afterRequest.length > 1) return afterRequest[0];

  if (unpairedSameTier.length === 1) return unpairedSameTier[0];
  return null;
}

module.exports = {
  findUnpairedReleaseForSameTierPick,
  findOrphanPickToPairOnReleaseApprove,
  pickIsAlreadyPairedToARelease,
};
