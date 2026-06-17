const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const User = require('./models/User');
const Player = require('./models/Player');
const UserPlayer = require('./models/UserPlayer');

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: 'cpl_22',
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB Connected Successfully');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};

// Main function to sync user players comprehensively
const syncUserPlayersComprehensive = async () => {
  try {
    console.log('🚀 Starting comprehensive user-player sync...');
    
    // Find all users
    const users = await User.find({}).select('_id name teamName boughtPlayers');
    console.log(`📊 Found ${users.length} users to process`);
    
    let totalUsersProcessed = 0;
    let totalPlayersUpdated = 0;
    let totalPlayersAddedToBought = 0;
    let totalUsersUpdated = 0;
    
    // Process each user
    for (const user of users) {
      console.log(`\n👤 Processing user: ${user.teamName} (${user.name})`);
      console.log(`🆔 User ID: ${user._id}`);
      
      // Get all userPlayer records for this user (only active ones)
      const userPlayerRecords = await UserPlayer.find({ 
        userId: user._id,
        isActive: true
      }).select('playerId bidValue isActive');
      
      console.log(`📦 Found ${userPlayerRecords.length} userPlayer records`);
      
      if (userPlayerRecords.length === 0) {
        console.log(`  ⚠️  No userPlayer records found for ${user.teamName}`);
        totalUsersProcessed++;
        continue;
      }
      
      // Get current boughtPlayers array (or initialize empty array)
      let currentBoughtPlayers = user.boughtPlayers || [];
      let boughtPlayersUpdated = false;
      let userPlayersUpdated = 0;
      let playersAddedToBought = 0;
      
      console.log(`  📋 Current boughtPlayers count: ${currentBoughtPlayers.length}`);
      
      // Process each userPlayer record
      for (const userPlayer of userPlayerRecords) {
        const playerId = userPlayer.playerId;
        
        try {
          // Check if playerId exists in boughtPlayers array
          const isInBoughtPlayers = currentBoughtPlayers.some(
            boughtId => boughtId.toString() === playerId.toString()
          );
          
          if (isInBoughtPlayers) {
            console.log(`    ✅ Player ${playerId} already in boughtPlayers`);
          } else {
            console.log(`    ➕ Adding player ${playerId} to boughtPlayers`);
            currentBoughtPlayers.push(playerId);
            boughtPlayersUpdated = true;
            playersAddedToBought++;
            totalPlayersAddedToBought++;
          }
          
          // Update the player in Player collection
          const playerUpdateResult = await Player.updateOne(
            { _id: playerId },
            { 
              $set: { 
                isSold: true, 
                isActive: true 
              } 
            }
          );
          
          if (playerUpdateResult.matchedCount > 0) {
            if (playerUpdateResult.modifiedCount > 0) {
              console.log(`    🔄 Updated player ${playerId} - isSold: true, isActive: true`);
              userPlayersUpdated++;
              totalPlayersUpdated++;
            } else {
              console.log(`    ℹ️  Player ${playerId} already updated`);
            }
          } else {
            console.log(`    ❌ Player ${playerId} not found in Player collection`);
          }
          
        } catch (error) {
          console.error(`    ❌ Error processing player ${playerId}:`, error.message);
        }
      }
      
      // Update user's boughtPlayers array if it was modified
      if (boughtPlayersUpdated) {
        try {
          await User.updateOne(
            { _id: user._id },
            { $set: { boughtPlayers: currentBoughtPlayers } }
          );
          console.log(`  ✅ Updated boughtPlayers array for ${user.teamName}`);
          totalUsersUpdated++;
        } catch (error) {
          console.error(`  ❌ Error updating boughtPlayers for ${user.teamName}:`, error.message);
        }
      }
      
      console.log(`  📈 Summary for ${user.teamName}:`);
      console.log(`    - Players updated: ${userPlayersUpdated}`);
      console.log(`    - Players added to boughtPlayers: ${playersAddedToBought}`);
      console.log(`    - Final boughtPlayers count: ${currentBoughtPlayers.length}`);
      
      totalUsersProcessed++;
    }
    
    console.log('\n🎉 Comprehensive sync completed!');
    console.log(`📊 Final Summary:`);
    console.log(`  - Users processed: ${totalUsersProcessed}`);
    console.log(`  - Total players updated: ${totalPlayersUpdated}`);
    console.log(`  - Total players added to boughtPlayers: ${totalPlayersAddedToBought}`);
    console.log(`  - Users with updated boughtPlayers: ${totalUsersUpdated}`);
    
  } catch (error) {
    console.error('❌ Error in syncUserPlayersComprehensive:', error);
  }
};

// Verification function to check the results
const verifySyncResults = async () => {
  try {
    console.log('\n🔍 Verifying sync results...');
    
    // Count total sold players
    const soldPlayersCount = await Player.countDocuments({ isSold: true, isActive: true });
    console.log(`📊 Total sold and active players: ${soldPlayersCount}`);
    
    // Count total userPlayer records
    const userPlayerCount = await UserPlayer.countDocuments({});
    console.log(`📊 Total userPlayer records: ${userPlayerCount}`);
    
    // Check for any mismatches
    const usersWithBoughtPlayers = await User.find({
      boughtPlayers: { $exists: true, $ne: [] }
    }).select('_id teamName boughtPlayers');
    
    console.log(`📊 Users with boughtPlayers: ${usersWithBoughtPlayers.length}`);
    
    // Check for players that are in userPlayer but not in boughtPlayers
    let mismatches = 0;
    for (const user of usersWithBoughtPlayers) {
      const userPlayerRecords = await UserPlayer.find({ userId: user._id, isActive: true }).select('playerId');
      const userPlayerIds = userPlayerRecords.map(up => up.playerId.toString());
      const boughtPlayerIds = user.boughtPlayers.map(bp => bp.toString());
      
      const missingInBought = userPlayerIds.filter(id => !boughtPlayerIds.includes(id));
      if (missingInBought.length > 0) {
        console.log(`  ⚠️  ${user.teamName} has ${missingInBought.length} players in userPlayer but not in boughtPlayers`);
        mismatches++;
      }
    }
    
    if (mismatches === 0) {
      console.log('✅ All userPlayer records are properly synced with boughtPlayers!');
    } else {
      console.log(`⚠️  Found ${mismatches} users with sync issues`);
    }
    
  } catch (error) {
    console.error('❌ Error in verification:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    
    console.log('⚠️  WARNING: This script will sync userPlayer records with boughtPlayers');
    console.log('⚠️  and update player status. Make sure you have a backup!');
    console.log('⚠️  Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    
    // Wait 5 seconds before proceeding
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    await syncUserPlayersComprehensive();
    await verifySyncResults();
    
  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Handle process termination
process.on('SIGINT', async () => {
  console.log('\n⚠️  Script interrupted by user');
  await mongoose.connection.close();
  process.exit(0);
});

// Run the script
main();
