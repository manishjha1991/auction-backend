const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const User = require('./models/User');
const UserPlayer = require('./models/UserPlayer');

const args = process.argv.slice(2);
const tournamentArgIndex = args.indexOf('--tournamentId');
const tournamentIdRaw =
  (tournamentArgIndex >= 0 ? args[tournamentArgIndex + 1] : undefined) ||
  process.env.TOURNAMENT_ID ||
  null;
const tournamentId =
  tournamentIdRaw && mongoose.Types.ObjectId.isValid(String(tournamentIdRaw))
    ? new mongoose.Types.ObjectId(String(tournamentIdRaw))
    : null;

// MongoDB connection
const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    await mongoose.connect(
      process.env.MONGO_URI,
      process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : undefined
    );
    console.log('✅ MongoDB Connected Successfully');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};

// Main function to update purse values
const updatePurseTo100MinusPlayers = async () => {
  try {
    console.log('🚀 Starting purse update to 100 - players value...');
    
    // Get all users (excluding admins); optionally scoped to one tournament's subscribed teams.
    let userFilter = { isAdmin: { $ne: true } };
    if (tournamentId) {
      const tournament = await mongoose.connection.db
        .collection('tournaments')
        .findOne({ _id: tournamentId }, { projection: { subscribedTeams: 1 } });
      const userIds = (tournament?.subscribedTeams || [])
        .map((t) => t?.userId)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));
      userFilter = { ...userFilter, _id: { $in: userIds } };
      console.log(`🎯 Tournament scope enabled for ${String(tournamentId)} (${userIds.length} team users)`);
    }

    const users = await User.find(userFilter)
      .select('_id name teamName purse')
      .lean();
    
    console.log(`📊 Found ${users.length} users to process\n`);
    
    // Get all active user players with bid values
    const userPlayers = await UserPlayer.find(
      tournamentId ? { isActive: true, tournamentId } : { isActive: true }
    )
      .select('userId bidValue')
      .lean();
    
    // Group user players by userId
    const userPlayersMap = new Map();
    userPlayers.forEach(up => {
      const userId = up.userId.toString();
      if (!userPlayersMap.has(userId)) {
        userPlayersMap.set(userId, []);
      }
      userPlayersMap.get(userId).push(up);
    });
    
    console.log('='.repeat(100));
    console.log('PURSE UPDATE PREVIEW');
    console.log('='.repeat(100));
    console.log('| Team Name           | Current Purse | Players Value | New Purse | Difference |');
    console.log('|---------------------|---------------|---------------|-----------|------------|');
    
    let totalUsers = 0;
    let usersToUpdate = 0;
    const updateOperations = [];
    
    // Process each user
    for (const user of users) {
      const userPlayers = userPlayersMap.get(user._id.toString()) || [];
      
      // Calculate total bought players value
      const totalBoughtValue = userPlayers.reduce((sum, up) => {
        return sum + (Number(up.bidValue) || 0);
      }, 0);
      
      // Convert to crores
      const currentPurseCr = Number(user.purse || 0) / 10000000;
      const boughtValueCr = totalBoughtValue / 10000000;
      
      // Calculate new purse value (100 - players value)
      const newPurseCr = 100 - boughtValueCr;
      const newPurseValue = newPurseCr * 10000000; // Convert back to actual value
      
      // Format the output for table
      const teamName = (user.teamName || user.name || 'Unknown').substring(0, 20).padEnd(20);
      const currentStr = currentPurseCr.toFixed(2).padStart(13);
      const playersStr = boughtValueCr.toFixed(2).padStart(13);
      const newStr = newPurseCr.toFixed(2).padStart(9);
      const diffValue = newPurseCr - currentPurseCr;
      const diffStr = Math.abs(diffValue).toFixed(2).padStart(10);
      
      console.log(`| ${teamName} | ${currentStr} | ${playersStr} | ${newStr} | ${diffStr} |`);
      
      // Prepare update operation
      updateOperations.push({
        userId: user._id,
        teamName: user.teamName || user.name,
        currentPurse: user.purse,
        newPurse: mongoose.Types.Decimal128.fromString(newPurseValue.toString()),
        playersValue: totalBoughtValue,
        difference: newPurseCr - currentPurseCr
      });
      
      if (Math.abs(newPurseCr - currentPurseCr) > 0.01) {
        usersToUpdate++;
      }
      
      totalUsers++;
    }
    
    console.log('='.repeat(100));
    console.log(`📊 PREVIEW SUMMARY:`);
    console.log(`  - Total users processed: ${totalUsers}`);
    console.log(`  - Users that will be updated: ${usersToUpdate}`);
    console.log(`  - Users with no change needed: ${totalUsers - usersToUpdate}`);
    console.log('='.repeat(100));
    
    // Wait for confirmation
    console.log('\n⚠️  WARNING: This will update purse values in the database!');
    console.log('⚠️  Type "CONFIRM" to proceed with the update, or anything else to cancel:');
    
    // Simple confirmation (you can type CONFIRM when prompted)
    const readline = require('readline');
    const rl = readline.createInterface({ 
      input: process.stdin, 
      output: process.stdout 
    });
    
    const answer = await new Promise(resolve => {
      rl.question('', resolve);
    });
    
    rl.close();
    
    if (answer === 'CONFIRM') {
      console.log('\n🔄 Proceeding with updates...');
      
      let updatedCount = 0;
      let errorCount = 0;
      
      for (const op of updateOperations) {
        try {
          await User.findByIdAndUpdate(op.userId, { purse: op.newPurse });
          console.log(`✅ Updated ${op.teamName}: ${Number(op.currentPurse)/10000000} Cr → ${Number(op.newPurse)/10000000} Cr`);
          updatedCount++;
        } catch (error) {
          console.error(`❌ Failed to update ${op.teamName}:`, error.message);
          errorCount++;
        }
      }
      
      console.log('\n🎉 Purse update completed!');
      console.log(`📊 Summary:`);
      console.log(`  - Successfully updated: ${updatedCount} users`);
      console.log(`  - Errors encountered: ${errorCount} users`);
      
    } else {
      console.log('\n❌ Update cancelled by user.');
    }
    
  } catch (error) {
    console.error('❌ Error in updatePurseTo100MinusPlayers:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await updatePurseTo100MinusPlayers();
  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Run the script
main();
