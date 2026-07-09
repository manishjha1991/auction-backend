/**
 * One-time backfill for per-player, per-team, per-CPL stats.
 *
 * Usage from auction-backend:
 *   MONGO_DB_NAME=cpl_22 node scripts/backfillPlayerTeamTournamentStats.js
 *
 * Optional:
 *   CPL_TEAM_PLAYER_STATS_DBS=cpl_12,cpl_13,cpl_14 node scripts/backfillPlayerTeamTournamentStats.js
 *   CPL_TEAM_PLAYER_STATS_FROM=12 CPL_TEAM_PLAYER_STATS_TO=22 node scripts/backfillPlayerTeamTournamentStats.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const {
  backfillPlayerTeamTournamentStats,
  getBackfillSourceDbs,
} = require('../utils/playerTeamTournamentStats');

async function main() {
  const dbName = process.env.MONGO_DB_NAME || 'cpl_23';
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(process.env.MONGO_URI, { dbName });

  console.log('Backfilling player-team-tournament stats');
  console.log('Target DB:', mongoose.connection.name);
  console.log('Source DBs:', getBackfillSourceDbs().join(', '));

  const result = await backfillPlayerTeamTournamentStats();
  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
