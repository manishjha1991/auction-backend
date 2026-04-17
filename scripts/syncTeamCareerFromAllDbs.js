/**
 * One-off / periodic backfill: copy career matches & wins from historical DBs (cpl_12…cpl_20 by default)
 * into User.careerMatchesPlayed / careerWins on the app DB.
 *
 * After this, totals are maintained only by saving results on:
 *   league fixtures, playoff fixtures, and tournament (World Cup) fixtures — see utils/careerUserCounters.js.
 * Re-run this script if you need to reconcile against historical data again.
 *
 * Env: MONGO_URI, MONGO_DB_NAME (app DB). CPL_TEAM_CAREER_DBS — optional list of DBs to read.
 *
 * Usage: node scripts/syncTeamCareerFromAllDbs.js
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const { aggregateCareerStatsForTeams, norm } = require('../utils/teamCareerStats');
const { getScriptMongoUri } = require('../utils/scriptMongoUri');

const mongoUri = getScriptMongoUri();
/** Must match server.js / MONGO_DB_NAME — URI without /dbName defaults to `test` and yields 0 users. */
const dbName = process.env.MONGO_DB_NAME || 'cpl_20';

async function run() {
  await mongoose.connect(mongoUri, { dbName });
  console.log(`Connected — database: ${mongoose.connection.name}`);
  try {
    const users = await User.findIncludingInactive({
      teamName: { $exists: true, $nin: [null, '', 'NA'] },
      isAdmin: { $ne: true },
    })
      .select('_id teamName')
      .lean();

    if (users.length === 0) {
      console.warn(
        'No users matched (non-admin, with teamName). If data lives elsewhere, set MONGO_DB_NAME in .env (default cpl_20).'
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
