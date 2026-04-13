/**
 * Seed PlayerCareerSummary.historical from historical DBs (cpl_12..cpl_18 by default),
 * rebuild live career blocks from current playerstats, and optionally recompute Player
 * document totals from current PlayerStats (Top Rankings).
 *
 * Expects mongoose to already be connected (HTTP handler). CLI scripts connect first.
 */
const mongoose = require('mongoose');
const Player = require('../models/Player');
const PlayerStats = require('../models/PlayerStats');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const {
  normName,
  emptyBlock,
  finalizeBlock,
  mergeBlocks,
  rebuildAllLiveCareerSummaries,
} = require('./playerCareerSummary');

function getSourceDbs() {
  return (process.env.CPL_HISTORY_SEED_DBS || 'cpl_15,cpl_16,cpl_17,cpl_18,cpl_19')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function addInnings(block, row) {
  const runs = Number(row?.battingStats?.runs) || 0;
  const balls = Number(row?.battingStats?.balls) || 0;
  const wickets = Number(row?.bowlingStats?.wickets) || 0;
  const runsGiven = Number(row?.bowlingStats?.runsGiven) || 0;
  const ballsBowled = Number(row?.bowlingStats?.ballsBowled) || 0;
  const opponentTeam = row.opponentTeam || 'Unknown';
  const date = row.createdAt || null;

  block.totalRuns += runs;
  block.totalBalls += balls;
  block.innings += 1;
  block.totalWickets += wickets;
  block.totalRunsGiven += runsGiven;
  block.totalBallsBowled += ballsBowled;
  if (wickets > 0 || runsGiven > 0 || ballsBowled > 0) block.bowlingInnings += 1;
  if (runs > block.highestScore) block.highestScore = runs;

  if (runs >= 100) {
    block.totalHundreds += 1;
    block.centuries.push({ runs, balls, opponentTeam, date });
  } else if (runs >= 50 && runs < 100) {
    block.totalFifties += 1;
    block.fifties.push({ runs, balls, opponentTeam, date });
  }
  if (wickets > 0 || runsGiven > 0 || ballsBowled > 0) {
    block.bestBowlingSpells.push({ wickets, runsGiven, ballsBowled, opponentTeam, date });
  }
}

/**
 * Same aggregation as routes/playerStats `updatePlayerCumulativeStats` — kept here so admin
 * can batch-rebuild Top Rankings fields without importing the router.
 */
async function updatePlayerCumulativeStatsFromStats(playerId) {
  const allStats = await PlayerStats.find({ playerId });

  let totalRuns = 0;
  let totalBalls = 0;
  let totalRunsGiven = 0;
  let totalBallsBowled = 0;
  let totalWickets = 0;
  let momCount = 0;

  allStats.forEach((stat) => {
    totalRuns += stat.battingStats?.runs || 0;
    totalBalls += stat.battingStats?.balls || 0;
    totalRunsGiven += stat.bowlingStats?.runsGiven || 0;
    totalBallsBowled += stat.bowlingStats?.ballsBowled || 0;
    totalWickets += stat.bowlingStats?.wickets || 0;
    if (stat.isMom) momCount += 1;
  });

  await Player.findByIdAndUpdate(playerId, {
    $set: {
      totalRuns,
      totalBalls,
      totalRunsGiven,
      totalBallsBowled,
      totalWickets,
      momCount,
      matchesPlayed: allStats.length,
    },
  });
}

async function rebuildAllPlayerTotalsFromCurrentStats() {
  const ids = await PlayerStats.distinct('playerId');
  let updated = 0;
  for (const playerId of ids) {
    if (!playerId) continue;
    await updatePlayerCumulativeStatsFromStats(playerId);
    updated += 1;
  }
  return { playersUpdated: updated };
}

/**
 * Seed historical career blocks from SOURCE_DBS and merge with live; then rebuild live from DB.
 */
async function runCareerHistorySeed() {
  const SOURCE_DBS = getSourceDbs();
  const currentPlayers = await Player.find({}).select('_id name role').lean();
  const currentByKey = new Map(currentPlayers.map((p) => [normName(p.name), p]));
  const aggregateByKey = new Map();
  const perDb = [];

  for (const dbName of SOURCE_DBS) {
    const conn = mongoose.connection.useDb(dbName, { useCache: true });
    const db = conn.db;
    const [statsDocs, playerDocs, userDocs] = await Promise.all([
      db.collection('playerstats').find({ playerId: { $exists: true, $ne: null } }).toArray(),
      db.collection('players').find({}).project({ _id: 1, name: 1 }).toArray(),
      db.collection('users').find({}).project({ _id: 1, teamName: 1, abbreviation: 1 }).toArray(),
    ]);
    const playerById = new Map(playerDocs.map((p) => [String(p._id), p]));
    const userById = new Map(userDocs.map((u) => [String(u._id), u.abbreviation || u.teamName || 'Unknown']));

    for (const row of statsDocs) {
      const p = playerById.get(String(row.playerId));
      if (!p?.name) continue;
      const key = normName(p.name);
      if (!aggregateByKey.has(key)) {
        aggregateByKey.set(key, {
          playerName: p.name,
          role: '',
          teams: new Set(),
          historical: emptyBlock(),
        });
      }
      const holder = aggregateByKey.get(key);
      const opponentTeam = userById.get(String(row.opponentUserId || '')) || 'Unknown';
      addInnings(holder.historical, { ...row, opponentTeam });
      const ownerTeam = userById.get(String(row.userId || ''));
      if (ownerTeam) holder.teams.add(ownerTeam);
    }
    perDb.push({ database: dbName, inningsRead: statsDocs.length });
  }

  let upserts = 0;
  for (const [key, value] of aggregateByKey.entries()) {
    const current = currentByKey.get(key);
    const historical = finalizeBlock(value.historical);
    const existing = await PlayerCareerSummary.findOne({ playerKey: key }).lean();
    const live = existing?.live || emptyBlock();
    const total = mergeBlocks(historical, live);

    await PlayerCareerSummary.findOneAndUpdate(
      { playerKey: key },
      {
        $set: {
          playerKey: key,
          playerName: current?.name || value.playerName,
          playerId: current?._id || null,
          role: current?.role || value.role || '',
          teams: [...value.teams],
          historical,
          live,
          total,
        },
      },
      { upsert: true, new: true },
    );
    upserts += 1;
  }

  await rebuildAllLiveCareerSummaries();

  return {
    upserts,
    aggregateKeys: aggregateByKey.size,
    perDb,
  };
}

function getCareerHistorySeedPreview() {
  return {
    sourceDatabases: getSourceDbs(),
    currentDatabase: mongoose.connection.name || null,
  };
}

module.exports = {
  getSourceDbs,
  runCareerHistorySeed,
  rebuildAllPlayerTotalsFromCurrentStats,
  getCareerHistorySeedPreview,
  /** Recompute Player document aggregates from current PlayerStats rows (single player). */
  recomputePlayerDocumentTotalsFromStats: updatePlayerCumulativeStatsFromStats,
};
