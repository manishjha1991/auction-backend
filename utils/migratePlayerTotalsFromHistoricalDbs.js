/**
 * Aggregate PlayerStats from multiple DBs on the same cluster (by player name across seasons),
 * then set Player.totalRuns / totalWickets / matchesPlayed on the current database.
 *
 * Uses the live mongoose connection + useDb (no hardcoded URI). Source list:
 * CPL_PLAYER_TOTALS_MIGRATE_DBS (default: cpl_12…cpl_19).
 */
const mongoose = require('mongoose');
const Player = require('../models/Player');

function getMigrateSourceDbs() {
  return (
    process.env.CPL_PLAYER_TOTALS_MIGRATE_DBS ||
    'cpl_15,cpl_16,cpl_17,cpl_18,cpl_19,cpl_20'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toObjectId(id) {
  try {
    if (id == null) return null;
    const s = String(id);
    if (!mongoose.Types.ObjectId.isValid(s)) return null;
    return new mongoose.Types.ObjectId(s);
  } catch {
    return null;
  }
}

async function findPlayerInTarget(playerName) {
  const trimmed = String(playerName || '').trim();
  if (!trimmed) return null;
  const safe = escapeRegex(trimmed);
  let player = await Player.findOne({ name: { $regex: `^${safe}$`, $options: 'i' } });
  if (player) return player;
  const nameParts = trimmed.split(/\s+/);
  if (nameParts.length >= 2) {
    const firstName = escapeRegex(nameParts[0]);
    const lastName = escapeRegex(nameParts[nameParts.length - 1]);
    player = await Player.findOne({
      name: { $regex: `^${firstName}.*${lastName}$`, $options: 'i' },
    });
  }
  return player || null;
}

/**
 * Per-source-DB totals keyed by playerId string, then merged by player name in aggregateAcrossSources.
 */
async function calculatePlayerTotalsFromDatabase(dbName) {
  const conn = mongoose.connection.useDb(dbName, { useCache: true });
  const allStats = await conn.db.collection('playerstats').find({}).toArray();
  const playerTotalsMap = {};

  for (const stat of allStats) {
    const playerId = String(stat.playerId);
    if (!playerTotalsMap[playerId]) {
      playerTotalsMap[playerId] = {
        totalRuns: 0,
        totalWickets: 0,
        matchesPlayed: 0,
        playerName: null,
      };
    }
    playerTotalsMap[playerId].totalRuns += stat.battingStats?.runs || 0;
    playerTotalsMap[playerId].totalWickets += stat.bowlingStats?.wickets || 0;
    playerTotalsMap[playerId].matchesPlayed += 1;
  }

  const ids = Object.keys(playerTotalsMap)
    .map(toObjectId)
    .filter(Boolean);
  if (ids.length) {
    const players = await conn.db
      .collection('players')
      .find({ _id: { $in: ids } }, { projection: { name: 1 } })
      .toArray();
    const nameById = {};
    players.forEach((p) => {
      nameById[String(p._id)] = p.name;
    });
    Object.keys(playerTotalsMap).forEach((pid) => {
      playerTotalsMap[pid].playerName = nameById[pid] || 'Unknown';
    });
  }

  return { playerTotalsMap, inningsCount: allStats.length };
}

function mergeIntoAggregated(aggregatedTotals, playerTotalsMap) {
  Object.keys(playerTotalsMap).forEach((playerId) => {
    const totals = playerTotalsMap[playerId];
    const playerName = totals.playerName || 'Unknown';
    if (!aggregatedTotals[playerName]) {
      aggregatedTotals[playerName] = {
        totalRuns: 0,
        totalWickets: 0,
        matchesPlayed: 0,
        sourcePlayerIds: [],
      };
    }
    aggregatedTotals[playerName].totalRuns += totals.totalRuns;
    aggregatedTotals[playerName].totalWickets += totals.totalWickets;
    aggregatedTotals[playerName].matchesPlayed += totals.matchesPlayed;
    aggregatedTotals[playerName].sourcePlayerIds.push(playerId);
  });
}

async function buildAggregatedTotals() {
  const sourceDbs = getMigrateSourceDbs();
  const aggregatedTotals = {};
  const perDb = [];
  let totalStatRowsRead = 0;

  for (const dbName of sourceDbs) {
    const { playerTotalsMap, inningsCount } = await calculatePlayerTotalsFromDatabase(dbName);
    totalStatRowsRead += inningsCount;
    mergeIntoAggregated(aggregatedTotals, playerTotalsMap);
    perDb.push({
      database: dbName,
      inningsCount,
      distinctPlayersInDb: Object.keys(playerTotalsMap).length,
    });
  }

  return { aggregatedTotals, perDb, totalStatRowsRead, sourceDbs };
}

async function countMatchPreview(aggregatedTotals) {
  let matched = 0;
  let notFound = 0;
  const notFoundPlayers = [];

  for (const [playerName, totals] of Object.entries(aggregatedTotals)) {
    const targetPlayer = await findPlayerInTarget(playerName);
    if (!targetPlayer) {
      notFound += 1;
      if (notFoundPlayers.length < 25) {
        notFoundPlayers.push({
          name: playerName,
          totalRuns: totals.totalRuns,
          totalWickets: totals.totalWickets,
          matchesPlayed: totals.matchesPlayed,
        });
      }
    } else {
      matched += 1;
    }
  }

  return { matched, notFound, notFoundPlayers };
}

async function previewMigratePlayerTotals() {
  const { aggregatedTotals, perDb, totalStatRowsRead, sourceDbs } = await buildAggregatedTotals();
  const activePlayerCount = await Player.countDocuments({ isActive: true });
  const uniqueNames = Object.keys(aggregatedTotals).length;
  const { matched, notFound, notFoundPlayers } = await countMatchPreview(aggregatedTotals);

  return {
    currentDatabase: mongoose.connection.name || null,
    sourceDatabases: sourceDbs,
    summary: {
      activePlayersInTarget: activePlayerCount,
      uniqueNamesFromSources: uniqueNames,
      totalStatRowsRead,
      wouldMatchTargetPlayers: matched,
      wouldNotFindInTarget: notFound,
    },
    perDb,
    notFoundSample: notFoundPlayers,
  };
}

async function executeMigratePlayerTotals() {
  const { aggregatedTotals, perDb, totalStatRowsRead, sourceDbs } = await buildAggregatedTotals();

  if (Object.keys(aggregatedTotals).length === 0) {
    return {
      aborted: true,
      message: 'No aggregated totals from source databases — did not reset or update any players.',
      perDb,
      totalStatRowsRead,
      sourceDatabases: sourceDbs,
    };
  }

  await Player.updateMany(
    { isActive: true },
    { $set: { totalRuns: 0, totalWickets: 0, matchesPlayed: 0 } },
  );

  let updated = 0;
  let notFound = 0;
  const notFoundPlayers = [];

  for (const [playerName, totals] of Object.entries(aggregatedTotals)) {
    const targetPlayer = await findPlayerInTarget(playerName);
    if (!targetPlayer) {
      notFound += 1;
      if (notFoundPlayers.length < 25) {
        notFoundPlayers.push({
          name: playerName,
          totalRuns: totals.totalRuns,
          totalWickets: totals.totalWickets,
          matchesPlayed: totals.matchesPlayed,
        });
      }
      continue;
    }

    await Player.findByIdAndUpdate(targetPlayer._id, {
      $set: {
        totalRuns: totals.totalRuns,
        totalWickets: totals.totalWickets,
        matchesPlayed: totals.matchesPlayed,
      },
    });
    updated += 1;
  }

  return {
    aborted: false,
    message: 'Migration completed.',
    sourceDatabases: sourceDbs,
    perDb,
    totalStatRowsRead,
    playersUpdated: updated,
    playersNotFoundInTarget: notFound,
    notFoundSample: notFoundPlayers,
  };
}

module.exports = {
  getMigrateSourceDbs,
  previewMigratePlayerTotals,
  executeMigratePlayerTotals,
};
