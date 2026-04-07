/**
 * Find duplicate PlayerStats (same player vs opponent + identical stat lines).
 * Used by admin HTTP routes (`/api/admin-tools/scripts/duplicate-player-stats/*`).
 */
const mongoose = require('mongoose');
const PlayerStats = require('../models/PlayerStats');
const Player = require('../models/Player');
const { upsertLiveCareerSummaryForPlayer } = require('./playerCareerSummary');
const { recomputePlayerDocumentTotalsFromStats } = require('./runCareerHistorySeed');

const MAX_GROUPS_IN_PREVIEW = 100;

function addStatFields() {
  return {
    $addFields: {
      br: { $ifNull: ['$battingStats.runs', 0] },
      bb: { $ifNull: ['$battingStats.balls', 0] },
      rg: { $ifNull: ['$bowlingStats.runsGiven', 0] },
      bbowl: { $ifNull: ['$bowlingStats.ballsBowled', 0] },
      wk: { $ifNull: ['$bowlingStats.wickets', 0] },
    },
  };
}

function groupStageBattingOnly() {
  return {
    $group: {
      _id: {
        playerId: '$playerId',
        opponentUserId: '$opponentUserId',
        battingRuns: '$br',
        battingBalls: '$bb',
      },
      count: { $sum: 1 },
      entries: {
        $push: {
          _id: '$_id',
          userId: '$userId',
          createdAt: '$createdAt',
          br: '$br',
          bb: '$bb',
          rg: '$rg',
          bbowl: '$bbowl',
          wk: '$wk',
        },
      },
    },
  };
}

function groupStageFull() {
  return {
    $group: {
      _id: {
        playerId: '$playerId',
        opponentUserId: '$opponentUserId',
        battingRuns: '$br',
        battingBalls: '$bb',
        runsGiven: '$rg',
        ballsBowled: '$bbowl',
        wickets: '$wk',
      },
      count: { $sum: 1 },
      entries: {
        $push: {
          _id: '$_id',
          userId: '$userId',
          createdAt: '$createdAt',
        },
      },
    },
  };
}

function sortEntries(entries, oldestFirst) {
  const mul = oldestFirst ? 1 : -1;
  return [...entries].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (ta !== tb) return (ta - tb) * mul;
    return String(a._id).localeCompare(String(b._id)) * mul;
  });
}

async function aggregateDuplicateGroups(battingOnly) {
  const coll = mongoose.connection.collection('playerstats');
  const pipeline = [
    addStatFields(),
    battingOnly ? groupStageBattingOnly() : groupStageFull(),
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ];
  return coll.aggregate(pipeline).toArray();
}

async function loadNameMaps(duplicateGroups) {
  const playerIds = [...new Set(duplicateGroups.flatMap((d) => [d._id.playerId]))].filter(Boolean);
  const opponentIds = [
    ...new Set(duplicateGroups.flatMap((d) => [d._id.opponentUserId]).filter(Boolean)),
  ];

  const players = await mongoose.connection
    .collection('players')
    .find({ _id: { $in: playerIds } }, { projection: { name: 1 } })
    .toArray();
  const users = await mongoose.connection
    .collection('users')
    .find({ _id: { $in: opponentIds } }, { projection: { teamName: 1, name: 1 } })
    .toArray();

  const playerName = (id) => {
    const p = players.find((x) => String(x._id) === String(id));
    return p ? p.name : String(id);
  };
  const teamLabel = (id) => {
    const u = users.find((x) => String(x._id) === String(id));
    return u ? u.teamName || u.name || String(id) : String(id);
  };

  return { playerName, teamLabel };
}

function serializeGroup(g, battingOnly, playerName, teamLabel) {
  const k = g._id;
  const entries = (g.entries || []).map((e) => ({
    id: String(e._id),
    userId: e.userId ? String(e.userId) : null,
    createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : null,
  }));
  const base = {
    playerId: String(k.playerId),
    playerName: playerName(k.playerId),
    opponentUserId: k.opponentUserId ? String(k.opponentUserId) : '',
    opponentName: k.opponentUserId ? teamLabel(k.opponentUserId) : '',
    duplicateCount: g.count,
    extraRowsToRemove: Math.max(0, g.count - 1),
    battingLine: `${k.battingRuns} runs / ${k.battingBalls} balls`,
    entries,
  };
  if (!battingOnly) {
    base.bowlingLine = `${k.runsGiven} runs given / ${k.ballsBowled} balls / ${k.wickets} wkts`;
  }
  return base;
}

/**
 * @param {{ battingOnly?: boolean }} options
 */
async function previewDuplicatePlayerStats(options = {}) {
  const battingOnly = !!options.battingOnly;
  const duplicates = await aggregateDuplicateGroups(battingOnly);
  const totalExtra = duplicates.reduce((s, g) => s + g.count - 1, 0);
  const { playerName, teamLabel } = await loadNameMaps(duplicates);

  const truncated = duplicates.length > MAX_GROUPS_IN_PREVIEW;
  const slice = duplicates.slice(0, MAX_GROUPS_IN_PREVIEW);
  const groups = slice.map((g) => serializeGroup(g, battingOnly, playerName, teamLabel));

  return {
    battingOnly,
    modeLabel: battingOnly
      ? 'Batting-only (player + opponent + runs + balls)'
      : 'Full row (player + opponent + batting + bowling line)',
    summary: {
      duplicateGroups: duplicates.length,
      extraDocumentsToDelete: totalExtra,
      groupsShown: groups.length,
      groupsTruncated: truncated,
    },
    groups,
  };
}

/**
 * @param {{ battingOnly?: boolean, keepNewest?: boolean }} options
 */
async function executeDeleteDuplicatePlayerStats(options = {}) {
  const battingOnly = !!options.battingOnly;
  const keepNewest = !!options.keepNewest;

  const duplicates = await aggregateDuplicateGroups(battingOnly);
  if (duplicates.length === 0) {
    return {
      battingOnly,
      keepNewest,
      deletedCount: 0,
      affectedPlayerCount: 0,
      message: 'No duplicate groups found; nothing to delete.',
    };
  }

  const idsToDelete = [];
  const affectedPlayerIds = new Set();

  for (const g of duplicates) {
    const sorted = sortEntries(g.entries, !keepNewest);
    const keep = sorted[0];
    const remove = sorted.slice(1);
    for (const r of remove) {
      idsToDelete.push(r._id);
      affectedPlayerIds.add(String(g._id.playerId));
    }
  }

  const delRes = await PlayerStats.deleteMany({ _id: { $in: idsToDelete } });

  for (const pid of affectedPlayerIds) {
    try {
      await recomputePlayerDocumentTotalsFromStats(pid);
    } catch (e) {
      console.error('recompute totals failed', pid, e.message);
    }
    try {
      await upsertLiveCareerSummaryForPlayer(pid);
    } catch (e) {
      console.warn('Career summary failed for', pid, e.message);
    }
  }

  return {
    battingOnly,
    keepNewest,
    deletedCount: delRes.deletedCount || 0,
    duplicateGroupsProcessed: duplicates.length,
    affectedPlayerCount: affectedPlayerIds.size,
    message: `Deleted ${delRes.deletedCount || 0} duplicate PlayerStats document(s).`,
  };
}

module.exports = {
  previewDuplicatePlayerStats,
  executeDeleteDuplicatePlayerStats,
};
