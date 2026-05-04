/**
 * One-off / periodic backfill: copy career matches & wins into
 * User.careerMatchesPlayed / careerWins on the app DB.
 *
 * After this, totals are maintained only by saving results on:
 *   league fixtures, playoff fixtures, and tournament (World Cup) fixtures — see utils/careerUserCounters.js.
 * Re-run this script if you need to reconcile against historical data again.
 *
 * Default source mode is SINGLE-DB tournament aggregation.
 * Optional legacy mode can still read historical databases.
 *
 * Env:
 *   MONGO_URI, optional MONGO_DB_NAME (target app DB)
 *   CPL_TEAM_CAREER_SOURCE=legacy-db          (optional; enables old multi-DB reads)
 *   CPL_TEAM_CAREER_DBS=cpl_15,cpl_16,...     (only used in legacy mode)
 *   CPL_TEAM_CAREER_TOURNAMENT_IDS=<id,...>   (optional tournament subset in single-db mode)
 *
 * Usage: node scripts/syncTeamCareerFromAllDbs.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');
const { aggregateCareerStatsForTeams, norm } = require('../utils/teamCareerStats');

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is required');
  }
  const dbName = process.env.MONGO_DB_NAME;
  await mongoose.connect(mongoUri, dbName ? { dbName } : undefined);
  console.log(`Connected — database: ${mongoose.connection.name}`);
  console.log(
    `Career source mode: ${
      String(process.env.CPL_TEAM_CAREER_SOURCE || '').toLowerCase() === 'legacy-db'
        ? 'legacy-dbs'
        : 'single-db-tournaments'
    }`
  );
  try {
    const users = await User.findIncludingInactive({
      teamName: { $exists: true, $nin: [null, '', 'NA'] },
      isAdmin: { $ne: true },
    })
      .select('_id teamName')
      .lean();

    if (users.length === 0) {
      console.warn(
        'No users matched (non-admin, with teamName). If data lives elsewhere, set MONGO_DB_NAME in .env.'
      );
    }

    const names = [...new Set(users.map((u) => u.teamName).filter(Boolean))];
    console.log(`Aggregating career stats for ${names.length} team names…`);
    const totals = await aggregateCareerStatsForTeams(names);

    let updated = 0;
    for (const u of users) {
      const k = norm(u.teamName);
      const t = totals[k];
      if (!t) continue;
      await User.findOneAndUpdate(
        { _id: u._id },
        {
          $set: {
            careerMatchesPlayed: t.careerPlayed,
            careerWins: t.careerWins,
          },
        },
        { includeInactive: true }
      );
      updated += 1;
    }
    console.log(`✅ Set career fields on ${updated} user documents.`);
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
