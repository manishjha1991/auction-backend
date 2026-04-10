const mongoose = require('mongoose');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');

const TIERS = ['Sapphire', 'Gold', 'Emerald', 'Silver'];

/**
 * Same-tier release + unsold pick only share one slot if they are the same roster move:
 * pick request filed after the release completed, within this window. Otherwise the pick
 * charges a separate slot (e.g. Sapphire pick after a trade must not pair to a stale Sapphire release).
 */
const MAX_MS_BETWEEN_RELEASE_COMPLETE_AND_PICK =
  Number(process.env.TRADE_RELEASE_PICK_PAIR_MAX_MS) || 21 * 24 * 60 * 60 * 1000;

function releaseEligibleToPairPickRequest(releaseDoc, pickCreatedAt) {
  if (!pickCreatedAt) return true;
  const pickT = new Date(pickCreatedAt).getTime();
  if (Number.isNaN(pickT)) return true;
  const relT = releaseDoc.updatedAt ? new Date(releaseDoc.updatedAt).getTime() : 0;
  if (Number.isNaN(relT)) return true;
  if (pickT < relT) return false;
  if (pickT - relT > MAX_MS_BETWEEN_RELEASE_COMPLETE_AND_PICK) return false;
  return true;
}

/** When approving a release, do not pair a same-tier pick completed ages ago (unrelated move). */
function orphanPickRecentEnoughRelativeToNow(pickLean) {
  const pickT = pickLean.updatedAt ? new Date(pickLean.updatedAt).getTime() : 0;
  if (!pickT) return false;
  return Date.now() - pickT <= MAX_MS_BETWEEN_RELEASE_COMPLETE_AND_PICK;
}

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
 * @param {Date} [pickCreatedAt] - PickRequest.createdAt; required for correct slot accounting.
 */
async function findUnpairedReleaseForSameTierPick(userId, pickPlayerType, pickCreatedAt) {
  if (!TIERS.includes(pickPlayerType)) return null;
  const uid = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const explicitList = await ReleaseRequest.find({
    user: uid,
    status: 'completed',
    releasedPlayerType: pickPlayerType,
    ...unpairedReleaseFilter(),
  })
    .sort({ updatedAt: -1 })
    .limit(40)
    .lean();

  for (const rel of explicitList) {
    if (releaseEligibleToPairPickRequest(rel, pickCreatedAt)) {
      return ReleaseRequest.findById(rel._id);
    }
  }

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
    { $limit: 40 },
  ]);
  for (const row of legacy) {
    if (releaseEligibleToPairPickRequest(row, pickCreatedAt)) {
      return ReleaseRequest.findById(row._id);
    }
  }
  return null;
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

  if (unpairedSameTier.length === 1 && orphanPickRecentEnoughRelativeToNow(unpairedSameTier[0])) {
    return unpairedSameTier[0];
  }
  return null;
}

module.exports = {
  findUnpairedReleaseForSameTierPick,
  findOrphanPickToPairOnReleaseApprove,
  pickIsAlreadyPairedToARelease,
};
