/**
 * One-time script:
 * Seed PlayerCareerSummary.historical in current DB from historical DBs.
 *
 * Default source DBs: cpl_12..cpl_18 (NOT cpl_19 — current season is merged as "live" after seed).
 * Target DB: the database named in MONGO_URI path (…/cpl_19?…) OR MONGO_DB_NAME / DB_NAME.
 * If the URI has no DB segment (…mongodb.net/?…), Mongoose defaults to "test" — set MONGO_DB_NAME.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Player = require('../models/Player');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const {
  normName,
  emptyBlock,
  finalizeBlock,
  mergeBlocks,
  rebuildAllLiveCareerSummaries,
} = require('../utils/playerCareerSummary');

const MONGO_URI = process.env.MONGO_URI || '';
if (!MONGO_URI) {
  console.error('Missing MONGO_URI');
  process.exit(1);
}

/** True if URI path after host contains a database name (not just / or empty). */
function mongoUriHasDatabaseName(uri) {
  try {
    const noQuery = uri.split('?')[0];
    const idx = noQuery.indexOf('://');
    if (idx < 0) return true;
    const afterScheme = noQuery.slice(idx + 3);
    const slashAfterHost = afterScheme.indexOf('/');
    if (slashAfterHost < 0) return false;
    const path = afterScheme.slice(slashAfterHost + 1);
    return path.replace(/\/$/, '').length > 0;
  } catch {
    return true;
  }
}

const explicitDbName = (process.env.MONGO_DB_NAME || process.env.DB_NAME || '').trim();
if (!mongoUriHasDatabaseName(MONGO_URI) && !explicitDbName) {
  console.error(
    'MONGO_URI has no database in the path (e.g. …mongodb.net/cpl_19?…). ' +
      'Data would go to the default DB (often "test"). Set MONGO_DB_NAME=cpl_19 (your live app DB) or fix the URI.',
  );
  process.exit(1);
}

const SOURCE_DBS = (process.env.CPL_HISTORY_SEED_DBS || 'cpl_12,cpl_13,cpl_14,cpl_15,cpl_16,cpl_17,cpl_18')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

async function main() {
  const connectOpts = {
    maxPoolSize: parseInt(process.env.MONGO_MAX_POOL_SIZE || '5', 10) || 5,
    minPoolSize: parseInt(process.env.MONGO_MIN_POOL_SIZE || '0', 10) || 0,
  };
  if (explicitDbName) {
    connectOpts.dbName = explicitDbName;
  }
  await mongoose.connect(MONGO_URI, connectOpts);

  const dbName = mongoose.connection.name;
  console.log(`Connected. PlayerCareerSummary writes go to database: "${dbName}" (collection: playercareersummaries)`);
  if (dbName === 'test' && !explicitDbName) {
    console.warn('Warning: using database "test". If that was not intended, set MONGO_DB_NAME or add /yourDb to MONGO_URI.');
  }

  const currentPlayers = await Player.find({}).select('_id name role').lean();
  const currentByKey = new Map(currentPlayers.map((p) => [normName(p.name), p]));
  const aggregateByKey = new Map();

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
    console.log(`Seeded from ${dbName}: ${statsDocs.length} innings`);
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

  // Ensure live block reflects current DB playerstats as of now.
  await rebuildAllLiveCareerSummaries();

  console.log(`Done. Upserted historical summaries for ${upserts} players.`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('Seed failed:', e.message || String(e));
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});

