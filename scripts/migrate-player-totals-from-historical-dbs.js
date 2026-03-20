const mongoose = require('mongoose');
const PlayerStats = require('../models/PlayerStats');
const Player = require('../models/Player');

const MONGODB_BASE_URI = 'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/';
/** Historical CPL DBs to aggregate (adjust if you still use older cpl_12..cpl_14 archives). */
const SOURCE_DATABASES = ['cpl_15', 'cpl_16', 'cpl_17', 'cpl_18'];
const TARGET_DATABASE = 'cpl_19';

/**
 * Migrate Player Totals from Historical Databases
 * 
 * This script:
 * 1. Resets totalRuns, totalWickets, matchesPlayed to 0 for all active players in target
 * 2. Connects to SOURCE_DATABASES, calculates totals from PlayerStats in each database
 * 3. Aggregates totals and updates Player collection in TARGET_DATABASE (live season)
 * 
 * Re-run safe: First deletes (resets) totals, then inserts fresh values. No duplicates.
 * 
 * Options:
 * --dry-run: Show what would be updated without actually updating
 */

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

/**
 * Calculate player totals from PlayerStats in a database
 */
async function calculatePlayerTotalsFromDatabase(dbName) {
  try {
    console.log(`\n📊 Calculating totals from ${dbName}...`);
    
    const sourceUri = `${MONGODB_BASE_URI}${dbName}?retryWrites=true&w=majority&appName=auction-app`;
    const sourceConnection = await mongoose.createConnection(sourceUri).asPromise();
    
    const SourcePlayerStats = sourceConnection.model('PlayerStats', PlayerStats.schema);
    const SourcePlayer = sourceConnection.model('Player', Player.schema);
    
    // Get all PlayerStats from source database
    const allStats = await SourcePlayerStats.find({}).lean();
    console.log(`   Found ${allStats.length} PlayerStats records`);
    
    // Aggregate totals by playerId
    const playerTotalsMap = {};
    
    allStats.forEach(stat => {
      const playerId = String(stat.playerId);
      
      if (!playerTotalsMap[playerId]) {
        playerTotalsMap[playerId] = {
          totalRuns: 0,
          totalWickets: 0,
          matchesPlayed: 0,
          playerName: null
        };
      }
      
      // Add runs
      playerTotalsMap[playerId].totalRuns += stat.battingStats?.runs || 0;
      
      // Add wickets
      playerTotalsMap[playerId].totalWickets += stat.bowlingStats?.wickets || 0;
      
      // Count matches
      playerTotalsMap[playerId].matchesPlayed += 1;
    });
    
    // Get player names for reference
    const playerIds = Object.keys(playerTotalsMap);
    const players = await SourcePlayer.find({ _id: { $in: playerIds } }).select('name').lean();
    const playerNameMap = {};
    players.forEach(p => {
      playerNameMap[String(p._id)] = p.name;
    });
    
    // Add player names to totals
    Object.keys(playerTotalsMap).forEach(playerId => {
      playerTotalsMap[playerId].playerName = playerNameMap[playerId] || 'Unknown';
    });
    
    await sourceConnection.close();
    
    console.log(`   Calculated totals for ${Object.keys(playerTotalsMap).length} players`);
    
    return playerTotalsMap;
    
  } catch (error) {
    console.error(`   ❌ Error calculating totals from ${dbName}:`, error.message);
    return {};
  }
}

/**
 * Find matching player in target database by name
 */
async function findPlayerInTarget(playerName, playerIdFromSource) {
  try {
    // First try to find by exact name match
    let player = await Player.findOne({ name: { $regex: `^${playerName}$`, $options: 'i' } });
    
    if (player) {
      return player;
    }
    
    // If not found, try partial match (first name + last name)
    const nameParts = playerName.trim().split(' ');
    if (nameParts.length >= 2) {
      const firstName = nameParts[0];
      const lastName = nameParts[nameParts.length - 1];
      player = await Player.findOne({
        name: { $regex: `^${firstName}.*${lastName}$`, $options: 'i' }
      });
    }
    
    return player || null;
  } catch (error) {
    console.error(`   Error finding player ${playerName}:`, error.message);
    return null;
  }
}

async function migratePlayerTotals() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('🚀 MIGRATING PLAYER TOTALS FROM HISTORICAL DATABASES');
    console.log('='.repeat(80));
    console.log(`📦 Source Databases: ${SOURCE_DATABASES.join(', ')}`);
    console.log(`🎯 Target Database: ${TARGET_DATABASE}`);
    
    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No data will be updated\n');
    }
    
    console.log('='.repeat(80) + '\n');
    
    // Connect to target database
    const targetUri = `${MONGODB_BASE_URI}${TARGET_DATABASE}?retryWrites=true&w=majority&appName=auction-app`;
    await mongoose.connect(targetUri);
    console.log(`✅ Connected to target database: ${TARGET_DATABASE}\n`);
    
    // Get current player totals in target database
    const currentPlayers = await Player.find({ isActive: true }).lean();
    console.log(`📊 Found ${currentPlayers.length} active players in ${TARGET_DATABASE}\n`);

    // Step 1: Reset all player totals to 0 to avoid duplicates on re-run
    if (!dryRun) {
      console.log('🗑️  Resetting player totals to 0...');
      await Player.updateMany(
        { isActive: true },
        { $set: { totalRuns: 0, totalWickets: 0, matchesPlayed: 0 } }
      );
      console.log('   ✅ Reset complete\n');
    } else {
      console.log('🔍 DRY RUN: Would reset all active player totals to 0\n');
    }
    
    // Aggregate totals from all source databases
    const aggregatedTotals = {};
    
    for (const sourceDb of SOURCE_DATABASES) {
      const dbTotals = await calculatePlayerTotalsFromDatabase(sourceDb);
      
      // Merge totals into aggregated map
      Object.keys(dbTotals).forEach(playerId => {
        const totals = dbTotals[playerId];
        const playerName = totals.playerName;
        
        // Use player name as key for matching (since player IDs differ across databases)
        if (!aggregatedTotals[playerName]) {
          aggregatedTotals[playerName] = {
            totalRuns: 0,
            totalWickets: 0,
            matchesPlayed: 0,
            sourcePlayerIds: []
          };
        }
        
        aggregatedTotals[playerName].totalRuns += totals.totalRuns;
        aggregatedTotals[playerName].totalWickets += totals.totalWickets;
        aggregatedTotals[playerName].matchesPlayed += totals.matchesPlayed;
        aggregatedTotals[playerName].sourcePlayerIds.push(playerId);
      });
    }
    
    console.log(`\n📊 Aggregated totals for ${Object.keys(aggregatedTotals).length} unique players from all source databases\n`);
    
    // Match players and update totals
    console.log('🔄 MATCHING PLAYERS AND UPDATING TOTALS');
    console.log('='.repeat(80) + '\n');
    
    let matched = 0;
    let updated = 0;
    let notFound = 0;
    const notFoundPlayers = [];
    
    for (const [playerName, totals] of Object.entries(aggregatedTotals)) {
      // Find matching player in target database
      const targetPlayer = await findPlayerInTarget(playerName, totals.sourcePlayerIds[0]);
      
      if (!targetPlayer) {
        notFound++;
        notFoundPlayers.push({
          name: playerName,
          totalRuns: totals.totalRuns,
          totalWickets: totals.totalWickets,
          matchesPlayed: totals.matchesPlayed
        });
        continue;
      }
      
      matched++;
      
      // Set totals from aggregated historical data (totals were reset to 0 earlier)
      const newTotalRuns = totals.totalRuns;
      const newTotalWickets = totals.totalWickets;
      const newMatchesPlayed = totals.matchesPlayed;
      
      if (dryRun) {
        console.log(`🔍 Would update: ${playerName}`);
        console.log(`   Runs=${newTotalRuns}, Wickets=${newTotalWickets}, Matches=${newMatchesPlayed}\n`);
      } else {
        // Update player totals
        await Player.findByIdAndUpdate(targetPlayer._id, {
          $set: {
            totalRuns: newTotalRuns,
            totalWickets: newTotalWickets,
            matchesPlayed: newMatchesPlayed
          }
        });
        
        updated++;
        
        if (updated % 10 === 0) {
          process.stdout.write(`   Updated ${updated} players...\r`);
        }
      }
    }
    
    console.log(`\n✅ Migration Summary:`);
    console.log(`   - Players matched: ${matched}`);
    console.log(`   - Players updated: ${dryRun ? '(Would update ' + matched + ')' : updated}`);
    console.log(`   - Players not found: ${notFound}`);
    
    if (notFound > 0) {
      console.log(`\n⚠️  Players from historical databases not found in ${TARGET_DATABASE}:`);
      notFoundPlayers.slice(0, 10).forEach(p => {
        console.log(`   - ${p.name} (Runs: ${p.totalRuns}, Wickets: ${p.totalWickets}, Matches: ${p.matchesPlayed})`);
      });
      if (notFoundPlayers.length > 10) {
        console.log(`   ... and ${notFoundPlayers.length - 10} more`);
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log(dryRun ? '🔍 DRY RUN COMPLETED' : '✅ MIGRATION COMPLETED');
    console.log('='.repeat(80) + '\n');
    
    console.log('📝 IMPORTANT NOTES:');
    console.log('   - Resets all player totals first, then inserts fresh values (re-run safe, no duplicates)');
    console.log('   - It does NOT migrate PlayerStats from historical databases');
    console.log('   - Top Rankings will show cumulative totals from all tournaments via Player collection\n');
    
    await mongoose.connection.close();
    console.log('✅ Database connection closed\n');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

// Run migration
if (require.main === module) {
  migratePlayerTotals()
    .then(() => {
      console.log('✅ Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migratePlayerTotals };

