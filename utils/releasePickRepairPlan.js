const mongoose = require('mongoose');
const User = require('../models/User');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const Player = require('../models/Player');
const { pickIsAlreadyPairedToARelease } = require('./releasePickPairing');

const TIERS = ['Sapphire', 'Gold', 'Emerald', 'Silver'];

async function getPairedPickIdSet() {
  const rows = await ReleaseRequest.find({
    pairedPickRequest: { $exists: true, $ne: null },
  })
    .select('pairedPickRequest')
    .lean();
  return new Set(rows.map((d) => String(d.pairedPickRequest)));
}

function effectiveTierForRelease(release, playerById) {
  if (release.releasedPlayerType && TIERS.includes(release.releasedPlayerType)) {
    return release.releasedPlayerType;
  }
  const pid = release.player ? String(release.player) : null;
  const p = pid ? playerById.get(pid) : null;
  return p?.type && TIERS.includes(p.type) ? p.type : null;
}

async function ensurePlayersInCache(playerIds, playerById) {
  const missing = playerIds.filter((id) => id && !playerById.has(String(id)));
  if (!missing.length) return;
  const docs = await Player.find({ _id: { $in: missing } })
    .select('name type')
    .lean();
  for (const p of docs) {
    playerById.set(String(p._id), p);
  }
}

/**
 * Unpaired completed releases + unpaired completed picks of the same tier, matched in
 * chronological order (oldest release ↔ oldest pick per tier). Each pair implies one extra
 * tradesUsed that can be fixed by linking pairedPickRequest and decrementing tradesUsed by 1.
 */
async function buildRepairPairsForUser(userId, pairedPickIdSet, playerById) {
  const uid = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const releases = await ReleaseRequest.find({
    user: uid,
    status: 'completed',
    $or: [{ pairedPickRequest: null }, { pairedPickRequest: { $exists: false } }],
  })
    .select('player releasedPlayerType updatedAt createdAt')
    .sort({ updatedAt: 1 })
    .lean();

  const relPlayerIds = releases.map((r) => r.player).filter(Boolean);
  await ensurePlayersInCache(relPlayerIds, playerById);

  const releasesWithTier = [];
  for (const r of releases) {
    const eff = effectiveTierForRelease(r, playerById);
    if (!eff) continue;
    releasesWithTier.push({ ...r, effTier: eff });
  }

  const picks = await PickRequest.find({ user: uid, status: 'completed' })
    .populate('player', 'name type')
    .sort({ updatedAt: 1 })
    .lean();

  const unpairedPicks = picks.filter((p) => !pairedPickIdSet.has(String(p._id)));

  const picksByTier = {};
  for (const p of unpairedPicks) {
    const t = p.player?.type;
    if (!TIERS.includes(t)) continue;
    if (!picksByTier[t]) picksByTier[t] = [];
    picksByTier[t].push(p);
  }

  const releasesByTier = {};
  for (const r of releasesWithTier) {
    if (!releasesByTier[r.effTier]) releasesByTier[r.effTier] = [];
    releasesByTier[r.effTier].push(r);
  }

  const pairs = [];
  for (const t of TIERS) {
    const rel = releasesByTier[t] || [];
    const pic = picksByTier[t] || [];
    const n = Math.min(rel.length, pic.length);
    for (let i = 0; i < n; i++) {
      const relPl = playerById.get(String(rel[i].player));
      pairs.push({
        tier: t,
        releaseId: String(rel[i]._id),
        pickId: String(pic[i]._id),
        releasePlayerName: relPl?.name || '—',
        pickPlayerName: pic[i].player?.name || '—',
        releaseAt: rel[i].updatedAt,
        pickAt: pic[i].updatedAt,
      });
    }
  }
  return pairs;
}

async function buildFullRepairPreview() {
  const pairedPickIdSet = await getPairedPickIdSet();
  const users = await User.find({ isActive: true, isAdmin: false })
    .select('_id teamName name tradesUsed')
    .sort({ teamName: 1 })
    .lean();

  const playerById = new Map();
  const teams = [];
  let totalPairs = 0;

  for (const u of users) {
    const pairs = await buildRepairPairsForUser(u._id, pairedPickIdSet, playerById);
    if (!pairs.length) continue;
    totalPairs += pairs.length;
    const tu = Number(u.tradesUsed) || 0;
    teams.push({
      userId: String(u._id),
      teamName: u.teamName || u.name || 'Unknown',
      tradesUsedBefore: tu,
      decrementBy: pairs.length,
      tradesUsedAfter: Math.max(0, tu - pairs.length),
      pairs,
    });
  }

  return {
    teams,
    totalPairs,
    totalTeams: teams.length,
    note:
      'Each row pairs the oldest unlinked release with the oldest unlinked pick of that tier. Review unusual cases (multiple Gold moves). Applying links releases to picks and lowers tradesUsed by the number of pairs for that team.',
  };
}

/**
 * @param {Set<string>|null} userIdFilter - if set, only repair these user ids
 */
async function executeReleasePickRepairs(userIdFilter) {
  const preview = await buildFullRepairPreview();
  const targets = userIdFilter
    ? preview.teams.filter((t) => userIdFilter.has(t.userId))
    : preview.teams;

  const results = [];
  for (const team of targets) {
    let applied = 0;
    const uid = new mongoose.Types.ObjectId(team.userId);

    for (const pair of team.pairs) {
      const rel = await ReleaseRequest.findById(pair.releaseId);
      if (!rel || rel.status !== 'completed') continue;
      if (rel.pairedPickRequest) continue;
      if (String(rel.user) !== team.userId) continue;

      if (await pickIsAlreadyPairedToARelease(pair.pickId)) continue;

      const pick = await PickRequest.findById(pair.pickId);
      if (!pick || pick.status !== 'completed') continue;
      if (String(pick.user) !== team.userId) continue;

      const [relPl, pickPl] = await Promise.all([
        Player.findById(rel.player).select('type').lean(),
        Player.findById(pick.player).select('type').lean(),
      ]);
      if (!relPl || !pickPl || relPl.type !== pickPl.type) continue;

      const setFields = { pairedPickRequest: pick._id };
      if (!rel.releasedPlayerType && relPl.type) setFields.releasedPlayerType = relPl.type;

      const ures = await ReleaseRequest.updateOne(
        {
          _id: rel._id,
          $or: [{ pairedPickRequest: null }, { pairedPickRequest: { $exists: false } }],
        },
        { $set: setFields }
      );
      if (ures.modifiedCount !== 1) continue;
      applied += 1;
    }

    if (applied > 0) {
      await User.collection.updateOne({ _id: uid }, [
        { $set: { tradesUsed: { $max: [{ $subtract: ['$tradesUsed', applied] }, 0] } } },
      ]);
    }

    results.push({
      userId: team.userId,
      teamName: team.teamName,
      pairsAttempted: team.pairs.length,
      pairsApplied: applied,
    });
  }

  return {
    ok: true,
    results,
    summary: {
      teamsProcessed: results.length,
      pairsApplied: results.reduce((s, r) => s + r.pairsApplied, 0),
    },
  };
}

module.exports = {
  buildFullRepairPreview,
  executeReleasePickRepairs,
  TIERS,
};
