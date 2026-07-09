/**
 * Fold all prior-season playerstats into PlayerCareerSummary.historical, then rebuild
 * live blocks from the current DB's playerstats and sync Player totals (Top Rankings).
 *
 * Run after starting a new CPL season DB so totals = end-of-last-season + new uploads.
 *
 * Usage (from auction-backend/):
 *   node scripts/reseedCareerHistoryForSeason.js
 *
 * Env: MONGO_URI, MONGO_DB_NAME (active season, e.g. cpl_22)
 * Optional: CPL_HISTORY_SEED_DBS, CPL_HISTORY_SEED_FROM (default 15)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  getSourceDbs,
  runCareerHistorySeed,
  getCareerHistorySeedPreview,
} = require('../utils/runCareerHistorySeed');

async function main() {
  const dbName = process.env.MONGO_DB_NAME || 'cpl_23';
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  console.log('Reseeding career history');
  console.log('Active DB:', mongoose.connection.name);
  console.log('Source DBs:', getSourceDbs().join(', '));
  console.log('Preview:', getCareerHistorySeedPreview());

  const result = await runCareerHistorySeed();
  console.log('\nDone:', JSON.stringify(result, null, 2));

  const Player = require('../models/Player');
  const root = await Player.findOne({ name: /joe root/i })
    .select('name totalRuns matchesPlayed')
    .lean();
  if (root) {
    console.log('\nJoe Root check:', root);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
