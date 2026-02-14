#!/usr/bin/env node
/**
 * Update Head-to-Head from Playoff Fixtures in Historical CPL Databases
 *
 * Reads playoff fixtures (with winner) from cpl_12, cpl_14, cpl_15, cpl_16, cpl_17, cpl_18, cpl_19
 * and updates TeamHeadToHead in cpl_20. One-time script for older data.
 * From now onwards, playoff fixture updates in the app will auto-sync head-to-head.
 *
 * Usage:
 *   node scripts/sync-playoff-h2h-from-historical-dbs.js
 *
 * Options:
 *   --dry-run    Show what would be synced without updating
 */

const mongoose = require('mongoose');
const PlayoffFixture = require('../models/PlayoffFixture');
const TeamHeadToHead = require('../models/TeamHeadToHead');
const User = require('../models/User');
const { syncHeadToHead } = require('../routes/headToHead');

const MONGODB_BASE_URI = 'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/';
const SOURCE_DATABASES = ['cpl_12', 'cpl_14', 'cpl_15', 'cpl_16', 'cpl_17', 'cpl_18', 'cpl_19'];
const TARGET_DATABASE = 'cpl_20';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function getConnectionUri(dbName) {
  return `${MONGODB_BASE_URI}${dbName}?retryWrites=true&w=majority&appName=auction-app`;
}

function normalizePair(id1, id2) {
  if (!id1 || !id2) return null;
  const s1 = id1.toString();
  const s2 = id2.toString();
  return s1 < s2 ? [id1, id2] : [id2, id1];
}

async function syncPlayoffH2HFromHistorical() {
  console.log('\n' + '='.repeat(70));
  console.log('🔄 SYNC HEAD-TO-HEAD FROM PLAYOFF FIXTURES (HISTORICAL DBs)');
  console.log('='.repeat(70));
  console.log('📦 Source:', SOURCE_DATABASES.join(', '));
  console.log('🎯 Target H2H in:', TARGET_DATABASE);
  if (dryRun) console.log('🔍 DRY RUN - No updates\n');
  console.log('='.repeat(70) + '\n');

  const targetUri = getConnectionUri(TARGET_DATABASE);
  await mongoose.connect(targetUri, { dbName: TARGET_DATABASE });
  console.log(`✅ Connected to ${TARGET_DATABASE}\n`);

  const teamNameToUserId = {};
  const users = await User.find({ isActive: true }).select('_id teamName').lean();
  users.forEach((u) => {
    if (u.teamName) teamNameToUserId[u.teamName] = u._id;
  });
  console.log(`📋 Loaded ${Object.keys(teamNameToUserId).length} teams\n`);

  const processedKeys = new Set();
  let totalAdded = 0;

  for (const dbName of SOURCE_DATABASES) {
    try {
      const sourceUri = getConnectionUri(dbName);
      const conn = await mongoose.createConnection(sourceUri).asPromise();
      const PlayoffFixtureModel = conn.model('PlayoffFixture', PlayoffFixture.schema);

      const playoffs = await PlayoffFixtureModel.find({
        isCompleted: true,
        winner: { $exists: true, $ne: null, $ne: '' }
      }).lean();

      let added = 0;
      for (const p of playoffs) {
        if (!p.team1 || !p.team2 || !p.winner) continue;
        if (String(p.team1).includes('Winner of') || String(p.team1).includes('Loser of') ||
            String(p.team2).includes('Winner of') || String(p.team2).includes('Loser of')) continue;
        if (p.winner !== p.team1 && p.winner !== p.team2) continue;

        const ts = p.date ? new Date(p.date).getTime() : (p.updatedAt ? new Date(p.updatedAt).getTime() : String(p._id));
        const key = `${p.matchId}|${p.team1}|${p.team2}|${ts}`;
        if (processedKeys.has(key)) continue;

        const uid1 = teamNameToUserId[p.team1] || null;
        const uid2 = teamNameToUserId[p.team2] || null;
        const pair = normalizePair(uid1, uid2);
        if (!pair) continue;

        const [teamAId, teamBId] = pair;
        const teamAName = uid1?.toString() === teamAId.toString() ? p.team1 : p.team2;
        const teamBName = uid2?.toString() === teamBId.toString() ? p.team2 : p.team1;
        const winnerUserId = p.winner === p.team1 ? uid1 : uid2;
        const winnerIsFirst = winnerUserId?.toString() === teamAId.toString();

        if (!dryRun) {
          await TeamHeadToHead.findOneAndUpdate(
            { team1UserId: teamAId, team2UserId: teamBId },
            {
              $inc: {
                team1Wins: winnerIsFirst ? 1 : 0,
                team2Wins: winnerIsFirst ? 0 : 1,
                draws: 0
              },
              $set: {
                team1Name: teamAName,
                team2Name: teamBName,
                lastSyncedAt: new Date()
              }
            },
            { upsert: true }
          );
        }
        processedKeys.add(key);
        added++;
      }

      await conn.close();
      totalAdded += added;
      console.log(`   ${dbName}: ${added} playoff results → H2H`);
    } catch (err) {
      console.error(`   ❌ ${dbName}:`, err.message);
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`📊 Total: ${totalAdded} playoff results added to head-to-head`);
  if (dryRun) console.log('   (Dry run - no updates)');

  console.log('\n' + '='.repeat(70));
  console.log(dryRun ? '🔍 DRY RUN DONE' : '✅ SYNC COMPLETE');
  console.log('='.repeat(70) + '\n');

  await mongoose.connection.close();
  console.log('🔌 Disconnected\n');
}

if (require.main === module) {
  syncPlayoffH2HFromHistorical()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err);
      process.exit(1);
    });
}

module.exports = { syncPlayoffH2HFromHistorical };
