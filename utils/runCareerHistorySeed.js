/**
 * Seed PlayerCareerSummary.historical from historical DBs (cpl_12..cpl_18 by default),
 * rebuild live career blocks from current playerstats, and optionally recompute Player
 * document totals from current PlayerStats (Top Rankings).
 *
 * Expects mongoose to already be connected (HTTP handler). CLI scripts connect first.
 */
const mongoose = require('mongoose');
const Player = require('../models/Player');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const Tournament = require('../models/Tournament');
const {
  normName,
  emptyBlock,
  finalizeBlock,
  mergeBlocks,
  rebuildAllLiveCareerSummaries,
  syncAllPlayerRankingsFromCareerSummaries,
  upsertLiveCareerSummaryForPlayer,
} = require('./playerCareerSummary');

function getSourceDbs() {
  return (process.env.CPL_HISTORY_SEED_DBS || 'cpl_15,cpl_16,cpl_17,cpl_18,cpl_19,cpl_20')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function useLegacySeedMode() {
  const mode = String(process.env.CPL_HISTORY_SEED_SOURCE || '').toLowerCase();
  return mode === 'legacy-db' || mode === 'legacy-dbs' || mode === 'legacy';
}

async function getSourceTournaments() {
  const explicit = String(process.env.CPL_HISTORY_SEED_TOURNAMENT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (explicit.length) {
    return Tournament.find({ _id: { $in: explicit } })
      .select('_id name subscribedTeams')
      .lean();
  }

  return Tournament.find({ isActive: true })
    .select('_id name subscribedTeams endDate updatedAt')
    .sort({ endDate: -1, updatedAt: -1 })
    .lean();
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
 * Recompute career summary live block + push merged (historical + live) totals to Player for Top Rankings.
 */
async function updatePlayerCumulativeStatsFromStats(playerId) {
  await upsertLiveCareerSummaryForPlayer(playerId);
}

/** Rebuild live career blocks from PlayerStats and align Player totals with merged career (historical + live). */
async function rebuildAllPlayerTotalsFromCurrentStats() {
  await rebuildAllLiveCareerSummaries();
  return syncAllPlayerRankingsFromCareerSummaries();
}

/**
 * Seed historical career blocks from SOURCE_DBS and merge with live; then rebuild live from DB.
 */
async function runCareerHistorySeed() {
  const currentPlayers = await Player.find({}).select('_id name role').lean();
  const currentByKey = new Map(currentPlayers.map((p) => [normName(p.name), p]));
  const globalUsers = await mongoose.connection.db
    .collection('users')
    .find({})
    .project({ _id: 1, teamName: 1, abbreviation: 1 })
    .toArray();
  const globalUserById = new Map(
    globalUsers.map((u) => [String(u._id), u.abbreviation || u.teamName || 'Unknown'])
  );
  const aggregateByKey = new Map();
  const perDb = [];

  if (useLegacySeedMode()) {
    const SOURCE_DBS = getSourceDbs();
    for (const dbName of SOURCE_DBS) {
      const conn = mongoose.connection.useDb(dbName, { useCache: true });
      const db = conn.db;
      const [statsDocs, playerDocs, userDocs] = await Promise.all([
        db.collection('playerstats').find({ playerId: { $exists: true, $ne: null } }).toArray(),
        db.collection('players').find({}).project({ _id: 1, name: 1 }).toArray(),
        db.collection('users').find({}).project({ _id: 1, teamName: 1, abbreviation: 1 }).toArray(),
      ]);
      const playerById = new Map(playerDocs.map((p) => [String(p._id), p]));
      const userById = new Map(
        userDocs.map((u) => [String(u._id), u.abbreviation || u.teamName || 'Unknown'])
      );

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
  } else {
    const tournaments = await getSourceTournaments();
    const db = mongoose.connection.db;
    for (const tournament of tournaments) {
      const tournamentId = new mongoose.Types.ObjectId(String(tournament._id));
      const [statsDocs, playerDocs] = await Promise.all([
        db.collection('playerstats').find({ tournamentId, playerId: { $exists: true, $ne: null } }).toArray(),
        db.collection('players').find({}).project({ _id: 1, name: 1 }).toArray(),
      ]);
      const playerById = new Map(playerDocs.map((p) => [String(p._id), p]));
      const subscribedByUserId = new Map(
        (tournament.subscribedTeams || []).map((s) => [String(s.userId), s.teamName || 'Unknown'])
      );

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
        const opponentTeam =
          subscribedByUserId.get(String(row.opponentUserId || '')) ||
          globalUserById.get(String(row.opponentUserId || '')) ||
          'Unknown';
        addInnings(holder.historical, { ...row, opponentTeam });
        const ownerTeam =
          subscribedByUserId.get(String(row.userId || '')) || globalUserById.get(String(row.userId || ''));
        if (ownerTeam) holder.teams.add(ownerTeam);
      }
      perDb.push({
        database: `tournament:${String(tournament._id)}`,
        label: tournament.name || null,
        inningsRead: statsDocs.length,
      });
    }
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
  const rankingsSync = await syncAllPlayerRankingsFromCareerSummaries();

  return {
    upserts,
    aggregateKeys: aggregateByKey.size,
    perDb,
    rankingsSync,
  };
}

function getCareerHistorySeedPreview() {
  return useLegacySeedMode()
    ? {
        sourceMode: 'legacy-dbs',
        sourceDatabases: getSourceDbs(),
        currentDatabase: mongoose.connection.name || null,
      }
    : {
        sourceMode: 'single-db',
        sourceDatabases: [],
        currentDatabase: mongoose.connection.name || null,
        note: 'Uses tournaments in current DB; set CPL_HISTORY_SEED_SOURCE=legacy-db to use old multi-DB list.',
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
