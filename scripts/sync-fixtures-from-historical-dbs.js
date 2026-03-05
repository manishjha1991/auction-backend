#!/usr/bin/env node
/**
 * Sync Match Results and Playoff Fixtures from Historical CPL Databases into cpl_20
 *
 * Copies match results and playoff fixtures from cpl_12, cpl_14, cpl_15, cpl_16, cpl_17, cpl_18, cpl_19
 * into cpl_20 for head-to-head. After sync, runs head-to-head update.
 *
 * IMPORTANT: Does NOT insert or update Fixture collection. Fixtures are never touched.
 * Only MatchResult and PlayoffFixture are synced. This prevents duplicate fixtures.
 *
 * Usage:
 *   node scripts/sync-fixtures-from-historical-dbs.js
 *
 * Options:
 *   --dry-run    Show what would be synced without inserting (safe, no writes)
 *   --skip-h2h   Skip head-to-head sync at the end
 */

const mongoose = require('mongoose');
const MatchResult = require('../models/MatchResult');
const PlayoffFixture = require('../models/PlayoffFixture');
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

async function fetchMatchResultsFromSource(conn) {
  const MatchResultModel = conn.model('MatchResult', MatchResult.schema);
  return MatchResultModel.find({ winner: { $in: ['team1', 'team2'] } }).lean();
}

async function fetchPlayoffFixturesFromSource(conn) {
  const PlayoffFixtureModel = conn.model('PlayoffFixture', PlayoffFixture.schema);
  return PlayoffFixtureModel.find({ isCompleted: true, winner: { $exists: true, $ne: null, $ne: '' } }).lean();
}

async function syncFixturesAndMatchResults() {
  console.log('\n' + '='.repeat(70));
  console.log('🔄 SYNC MATCH RESULTS & PLAYOFF FIXTURES FROM HISTORICAL DBs → cpl_20');
  console.log('   (Fixture collection is NOT touched - no inserts)');
  console.log('='.repeat(70));
  console.log('📦 Source:', SOURCE_DATABASES.join(', '));
  console.log('🎯 Target:', TARGET_DATABASE);
  if (dryRun) console.log('🔍 DRY RUN - No data will be inserted\n');
  if (skipH2H) console.log('⏭️  Skipping head-to-head sync\n');
  console.log('='.repeat(70) + '\n');

  const targetUri = getConnectionUri(TARGET_DATABASE);
  await mongoose.connect(targetUri, { dbName: TARGET_DATABASE });
  console.log(`✅ Connected to target: ${TARGET_DATABASE}\n`);

  // Build team name lookup: exact + case-insensitive + variations (Royals XI -> Royals)
  const teamNameToUserId = {};
  const users = await User.find({ isActive: true }).select('_id teamName').lean();
  users.forEach((u) => {
    if (!u.teamName) return;
    const name = String(u.teamName).trim();
    teamNameToUserId[name] = u._id;
    teamNameToUserId[name.toLowerCase()] = u._id;
    const withoutSuffix = name.replace(/\s+(XI|11|CPL)$/i, '').trim();
    if (withoutSuffix && withoutSuffix !== name) {
      teamNameToUserId[withoutSuffix] = u._id;
      teamNameToUserId[withoutSuffix.toLowerCase()] = u._id;
    }
  });
  const resolveTeam = (name) => {
    if (!name) return { userId: null, canonicalName: null };
    const n = String(name).trim();
    const uid = teamNameToUserId[n] || teamNameToUserId[n.toLowerCase()] || null;
    const canonical = uid ? (users.find((u) => u._id.toString() === uid.toString())?.teamName || n) : n;
    return { userId: uid, canonicalName: canonical };
  };
  console.log(`📋 Loaded ${users.length} teams (with flexible name matching)\n`);

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
  // Content-based dedup: same teams + scores = same match (avoids "8th Match" vs "9th Match" duplicates from different DBs)
  const normalizeTeamForKey = (name) =>
    String(name || '').replace(/\p{Emoji}/gu, '').trim().toLowerCase();
  const buildMatchContentKey = (m) => {
    const t1 = normalizeTeamForKey(m.team1);
    const t2 = normalizeTeamForKey(m.team2);
    const pair = [t1, t2].sort().join('|');
    return `${pair}|${m.team1Score ?? 0}|${m.team2Score ?? 0}|${m.team1Wickets ?? 0}|${m.team2Wickets ?? 0}`;
  };
  const existingMatchContentKeys = new Set(
    (await MatchResult.find({}).select('team1 team2 team1Score team2Score team1Wickets team2Wickets').lean())
      .map(buildMatchContentKey)
  );
  const normalizePair = (id1, id2) => {
    if (!id1 || !id2) return null;
    const [a, b] = [id1.toString(), id2.toString()].sort();
    return `${a}|${b}`;
  };
  const existingPlayoffKeys = new Set(
    (await PlayoffFixture.find({}).select('matchId team1UserId team2UserId date').lean()).map((p) => {
      const pair = normalizePair(p.team1UserId, p.team2UserId) || `${p.team1}|${p.team2}`;
      const ts = p.date?.getTime?.() || p.date || p._id;
      return `${p.matchId}|${pair}|${ts}`;
    })
  );

  let totalMatchResultsAdded = 0;
  let totalPlayoffsAdded = 0;

  for (const dbName of SOURCE_DATABASES) {
    try {
      const sourceUri = getConnectionUri(dbName);
      const conn = await mongoose.createConnection(sourceUri).asPromise();
      console.log(`\n📂 ${dbName}`);

      const matchResults = await fetchMatchResultsFromSource(conn);
      const playoffFixtures = await fetchPlayoffFixturesFromSource(conn);
      console.log(`   Match results: ${matchResults.length}, Playoff fixtures: ${playoffFixtures.length}`);

      let matchResultsAdded = 0;
      let playoffsAdded = 0;

      for (const m of matchResults) {
        if (!m.matchNumber || !m.team1 || !m.team2) continue;
        if (existingMatchNumbers.has(m.matchNumber)) continue;
        const contentKey = buildMatchContentKey(m);
        if (existingMatchContentKeys.has(contentKey)) continue; // Same match from another DB (e.g. 8th vs 9th)

        const validMatchStatus = ['completed', 'abandoned', 'cancelled'].includes(m.matchStatus) ? m.matchStatus : 'completed';
        const validTrophyType = ['league', 'playoff', 'final', 'semi_final', 'quarter_final'].includes(m.trophyType) ? m.trophyType : 'league';
        const validMatchType = ['normal', 'playoff', 'final'].includes(m.matchType) ? m.matchType : 'normal';

        const doc = {
          matchNumber: m.matchNumber,
          matchTitle: m.matchTitle || 'Match',
          team1: m.team1,
          team2: m.team2,
          winner: m.winner,
          team1Score: m.team1Score ?? 0,
          team2Score: m.team2Score ?? 0,
          team1Wickets: m.team1Wickets ?? 0,
          team2Wickets: m.team2Wickets ?? 0,
          team1Overs: m.team1Overs ?? 0,
          team2Overs: m.team2Overs ?? 0,
          matchDate: m.matchDate,
          matchVenue: m.matchVenue || 'TBD',
          manOfTheMatch: m.manOfTheMatch || { name: 'TBD', team: m.team1, runs: 0, wickets: 0, balls: 0 },
          trophyName: m.trophyName || 'CPL',
          trophyType: validTrophyType,
          matchType: validMatchType,
          margin: m.margin || 'N/A',
          matchStatus: validMatchStatus,
          additionalNotes: m.additionalNotes || '',
          createdBy: adminUserId,
          createdAt: m.createdAt,
          headToHeadSynced: false,
        };

        if (!dryRun) {
          try {
            await MatchResult.create(doc);
            matchResultsAdded++;
          } catch (err) {
            console.error(`   ⚠️  Skip match ${m.matchNumber}: ${err.message}`);
          }
        } else {
          matchResultsAdded++;
        }
        existingMatchNumbers.add(m.matchNumber);
        existingMatchContentKeys.add(contentKey);
      }

      for (const p of playoffFixtures) {
        if (!p.team1 || !p.team2 || !p.matchId) continue;
        if (String(p.team1).includes('Winner of') || String(p.team1).includes('Loser of') ||
            String(p.team2).includes('Winner of') || String(p.team2).includes('Loser of')) continue;
        if (p.winner !== p.team1 && p.winner !== p.team2) continue;

        const r1 = resolveTeam(p.team1);
        const r2 = resolveTeam(p.team2);
        if (!r1.userId || !r2.userId) continue; // Skip if teams not in cpl_20
        const ts = p.date ? new Date(p.date).getTime() : (p.updatedAt ? new Date(p.updatedAt).getTime() : String(p._id));
        const pair = normalizePair(r1.userId, r2.userId);
        const key = `${p.matchId}|${pair}|${ts}`;
        if (existingPlayoffKeys.has(key)) continue;
        const team1UserId = r1.userId;
        const team2UserId = r2.userId;
        const winnerUserId = p.winner === p.team1 ? team1UserId : p.winner === p.team2 ? team2UserId : null;
        // Use cpl_20 canonical names so matches API finds them when user selects teams
        const team1Name = r1.canonicalName;
        const team2Name = r2.canonicalName;

        const validStages = ['ELIMINATOR ROUND', 'QUALIFIER 1', 'ELIMINATOR 2', 'QUALIFIER 2', 'FINALS', 'SEMI-FINAL 1', 'SEMI-FINAL 2', 'FINAL', 'WORLD CUP ROUND-ROBIN', 'WORLD CUP SEMI-FINAL 1', 'WORLD CUP SEMI-FINAL 2', 'WORLD CUP FINAL'];
        const stage = validStages.includes(p.stage) ? p.stage : 'FINALS';
        const doc = {
          matchId: p.matchId,
          stage,
          team1: team1Name,
          team2: team2Name,
          team1UserId: team1UserId || undefined,
          team2UserId: team2UserId || undefined,
          description: p.description || null,
          team1Score: p.team1Score || 'TBD',
          team2Score: p.team2Score || 'TBD',
          winner: p.winner === p.team1 ? team1Name : p.winner === p.team2 ? team2Name : p.winner,
          winnerUserId: winnerUserId || undefined,
          margin: p.margin || null,
          mom: p.mom || { name: null, score: 0, wickets: 0 },
          team1Fairness: p.team1Fairness ?? 0,
          team2Fairness: p.team2Fairness ?? 0,
          isCompleted: true,
          date: p.date,
          headToHeadSynced: false,
        };

        if (!dryRun) {
          try {
            await PlayoffFixture.create(doc);
            playoffsAdded++;
          } catch (err) {
            console.error(`   ⚠️  Skip playoff ${p.matchId} ${p.team1} vs ${p.team2}: ${err.message}`);
          }
        } else {
          playoffsAdded++;
        }
        existingPlayoffKeys.add(key);
      }

      await conn.close();

      totalMatchResultsAdded += matchResultsAdded;
      totalPlayoffsAdded += playoffsAdded;
      console.log(`   → Added: ${matchResultsAdded} match results, ${playoffsAdded} playoff fixtures`);
    } catch (err) {
      console.error(`   ❌ ${dbName}:`, err.message);
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`📊 Total: ${totalMatchResultsAdded} match results, ${totalPlayoffsAdded} playoff fixtures (fixtures not touched)`);
  if (dryRun) {
    console.log('   (Dry run - no data inserted)');
  }

  if (!dryRun && !skipH2H && (totalMatchResultsAdded > 0 || totalPlayoffsAdded > 0)) {
    console.log('\n🔄 Running head-to-head sync...');
    const synced = await syncHeadToHead();
    console.log(`   Synced ${synced} new results to TeamHeadToHead`);
  } else if (!skipH2H && totalMatchResultsAdded === 0 && totalPlayoffsAdded === 0) {
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
