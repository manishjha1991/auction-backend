#!/usr/bin/env node
/**
 * Sync Fixtures and Match Results from Historical CPL Databases into cpl_20
 *
 * Copies fixtures and match results from cpl_12, cpl_14, cpl_15, cpl_16, cpl_17, cpl_18, cpl_19
 * into cpl_20 so you have older fixtures for head-to-head. After sync, runs head-to-head update.
 *
 * Usage:
 *   node scripts/sync-fixtures-from-historical-dbs.js
 *
 * Options:
 *   --dry-run    Show what would be synced without inserting
 *   --skip-h2h   Skip head-to-head sync at the end
 */

const mongoose = require('mongoose');
const Fixture = require('../models/Fixture');
const MatchResult = require('../models/MatchResult');
const User = require('../models/User');
const { syncHeadToHead } = require('../routes/headToHead');

const MONGODB_BASE_URI = 'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/';
const SOURCE_DATABASES = ['cpl_12', 'cpl_14', 'cpl_15', 'cpl_16', 'cpl_17', 'cpl_18', 'cpl_19'];
const TARGET_DATABASE = 'cpl_20';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipH2H = args.includes('--skip-h2h');

function getConnectionUri(dbName) {
  return `${MONGODB_BASE_URI}${dbName}?retryWrites=true&w=majority&appName=auction-app`;
}

async function fetchFixturesFromSource(conn) {
  const FixtureModel = conn.model('Fixture', Fixture.schema);
  return FixtureModel.find({ isActive: true }).lean();
}

async function fetchMatchResultsFromSource(conn) {
  const MatchResultModel = conn.model('MatchResult', MatchResult.schema);
  return MatchResultModel.find({ winner: { $in: ['team1', 'team2'] } }).lean();
}

async function syncFixturesAndMatchResults() {
  console.log('\n' + '='.repeat(70));
  console.log('🔄 SYNC FIXTURES & MATCH RESULTS FROM HISTORICAL DBs → cpl_20');
  console.log('='.repeat(70));
  console.log('📦 Source:', SOURCE_DATABASES.join(', '));
  console.log('🎯 Target:', TARGET_DATABASE);
  if (dryRun) console.log('🔍 DRY RUN - No data will be inserted\n');
  if (skipH2H) console.log('⏭️  Skipping head-to-head sync\n');
  console.log('='.repeat(70) + '\n');

  const targetUri = getConnectionUri(TARGET_DATABASE);
  await mongoose.connect(targetUri, { dbName: TARGET_DATABASE });
  console.log(`✅ Connected to target: ${TARGET_DATABASE}\n`);

  const teamNameToUserId = {};
  const users = await User.find({ isActive: true }).select('_id teamName').lean();
  users.forEach((u) => {
    if (u.teamName) teamNameToUserId[u.teamName] = u._id;
  });
  console.log(`📋 Loaded ${Object.keys(teamNameToUserId).length} teams for User ID mapping\n`);

  let adminUserId = null;
  const admin = await User.findOne({ isAdmin: true, isActive: true }).select('_id').lean();
  if (admin) adminUserId = admin._id;
  if (!adminUserId) {
    const anyUser = await User.findOne({ isActive: true }).select('_id').lean();
    adminUserId = anyUser?._id;
  }
  if (!adminUserId) {
    console.error('❌ No user found in cpl_20 for MatchResult.createdBy. Match results require a valid user.');
    await mongoose.connection.close();
    process.exit(1);
  }

  const existingMatchNumbers = new Set(
    (await MatchResult.find({}).select('matchNumber').lean()).map((m) => m.matchNumber)
  );
  const existingFixtureKeys = new Set(
    (await Fixture.find({}).select('team1 team2 createdAt').lean()).map((f) =>
      `${f.team1}|${f.team2}|${f.createdAt?.getTime?.() || f.createdAt}`
    )
  );

  let totalFixturesAdded = 0;
  let totalMatchResultsAdded = 0;

  for (const dbName of SOURCE_DATABASES) {
    try {
      const sourceUri = getConnectionUri(dbName);
      const conn = await mongoose.createConnection(sourceUri).asPromise();
      console.log(`\n📂 ${dbName}`);

      const fixtures = await fetchFixturesFromSource(conn);
      const matchResults = await fetchMatchResultsFromSource(conn);
      console.log(`   Fixtures: ${fixtures.length}, Match results: ${matchResults.length}`);

      let fixturesAdded = 0;
      let matchResultsAdded = 0;

      for (const f of fixtures) {
        const key = `${f.team1}|${f.team2}|${new Date(f.createdAt).getTime()}`;
        if (existingFixtureKeys.has(key)) continue;

        const team1UserId = f.team1 ? teamNameToUserId[f.team1] : null;
        const team2UserId = f.team2 ? teamNameToUserId[f.team2] : null;
        const winnerUserId = f.winner === f.team1 ? team1UserId : f.winner === f.team2 ? team2UserId : null;

        const doc = {
          team1: f.team1,
          team2: f.team2,
          team1UserId: team1UserId || undefined,
          team2UserId: team2UserId || undefined,
          winner: f.winner || null,
          winnerUserId: winnerUserId || undefined,
          margin: f.margin || null,
          team1Score: f.team1Score || null,
          team2Score: f.team2Score || null,
          team1Overs: f.team1Overs || null,
          team2Overs: f.team2Overs || null,
          team1Fairness: f.team1Fairness ?? 0,
          team2Fairness: f.team2Fairness ?? 0,
          mom: f.mom || { name: null, score: null, wickets: null },
          createdAt: f.createdAt,
          isActive: true,
          group: f.group || null,
          matchType: f.matchType || 'normal',
          headToHeadSynced: false,
        };

        if (!dryRun) {
          await Fixture.create(doc);
        }
        existingFixtureKeys.add(key);
        fixturesAdded++;
      }

      for (const m of matchResults) {
        if (existingMatchNumbers.has(m.matchNumber)) continue;

        const doc = {
          matchNumber: m.matchNumber,
          matchTitle: m.matchTitle,
          team1: m.team1,
          team2: m.team2,
          winner: m.winner,
          team1Score: m.team1Score,
          team2Score: m.team2Score,
          team1Wickets: m.team1Wickets ?? 0,
          team2Wickets: m.team2Wickets ?? 0,
          team1Overs: m.team1Overs ?? 0,
          team2Overs: m.team2Overs ?? 0,
          matchDate: m.matchDate,
          matchVenue: m.matchVenue,
          manOfTheMatch: m.manOfTheMatch,
          trophyName: m.trophyName,
          trophyType: m.trophyType || 'league',
          matchType: m.matchType || 'normal',
          margin: m.margin,
          matchStatus: m.matchStatus || 'completed',
          additionalNotes: m.additionalNotes || '',
          createdBy: adminUserId || m.createdBy,
          createdAt: m.createdAt,
          headToHeadSynced: false,
        };

        if (!dryRun) {
          await MatchResult.create(doc);
        }
        existingMatchNumbers.add(m.matchNumber);
        matchResultsAdded++;
      }

      await conn.close();

      totalFixturesAdded += fixturesAdded;
      totalMatchResultsAdded += matchResultsAdded;
      console.log(`   → Added: ${fixturesAdded} fixtures, ${matchResultsAdded} match results`);
    } catch (err) {
      console.error(`   ❌ ${dbName}:`, err.message);
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`📊 Total: ${totalFixturesAdded} fixtures, ${totalMatchResultsAdded} match results`);
  if (dryRun) {
    console.log('   (Dry run - no data inserted)');
  }

  if (!dryRun && !skipH2H && (totalFixturesAdded > 0 || totalMatchResultsAdded > 0)) {
    console.log('\n🔄 Running head-to-head sync...');
    const synced = await syncHeadToHead();
    console.log(`   Synced ${synced} new results to TeamHeadToHead`);
  } else if (!skipH2H && totalFixturesAdded === 0 && totalMatchResultsAdded === 0) {
    console.log('\n🔄 No new data - running head-to-head sync anyway (catches any unsynced)...');
    const synced = await syncHeadToHead();
    console.log(`   Synced ${synced} new results to TeamHeadToHead`);
  }

  console.log('\n' + '='.repeat(70));
  console.log(dryRun ? '🔍 DRY RUN DONE' : '✅ SYNC COMPLETE');
  console.log('='.repeat(70) + '\n');

  await mongoose.connection.close();
  console.log('🔌 Disconnected\n');
}

if (require.main === module) {
  syncFixturesAndMatchResults()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err);
      process.exit(1);
    });
}

module.exports = { syncFixturesAndMatchResults };
