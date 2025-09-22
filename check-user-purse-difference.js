const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const User = require('./models/User');
const UserPlayer = require('./models/UserPlayer');

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: 'cpl_13_2',
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB Connected Successfully');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};

// Main function to check user purse differences
const checkUserPurseDifference = async () => {
  try {
    console.log('🚀 Starting user purse difference calculation...');
    
    // Get all users (excluding admins)
    const users = await User.find({ isAdmin: { $ne: true } })
      .select('_id name teamName purse')
      .lean();
    
    console.log(`📊 Found ${users.length} users to process\n`);
    
    // Get all active user players with bid values
    const userPlayers = await UserPlayer.find({ isActive: true })
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
    console.log('USER PURSE vs BOUGHT PLAYERS DIFFERENCE REPORT');
    console.log('='.repeat(100));
    console.log('| Team Name           | Purse (Cr) | Players (Cr) | Total Spent | 100 - Players | Remaining |');
    console.log('|---------------------|------------|--------------|-------------|---------------|-----------|');
    
    let totalUsers = 0;
    let usersWithDifference = 0;
    
    // Process each user
    for (const user of users) {
      const userPlayers = userPlayersMap.get(user._id.toString()) || [];
      
      // Calculate total bought players value
      const totalBoughtValue = userPlayers.reduce((sum, up) => {
        return sum + (Number(up.bidValue) || 0);
      }, 0);
      
      // Convert to crores
      const purseValueCr = Number(user.purse || 0) / 10000000;
      const boughtValueCr = totalBoughtValue / 10000000;
      
      // Calculate values
      const totalSpent = purseValueCr + boughtValueCr;
      const remainingFrom100 = 100 - totalSpent;
      const hundredMinusPlayers = 100 - boughtValueCr;
      
      // Format the output for table
      const teamName = (user.teamName || user.name || 'Unknown').substring(0, 20).padEnd(20);
      const purseStr = purseValueCr.toFixed(2).padStart(10);
      const boughtStr = boughtValueCr.toFixed(2).padStart(12);
      const totalSpentStr = totalSpent.toFixed(2).padStart(11);
      const hundredMinusStr = hundredMinusPlayers.toFixed(2).padStart(13);
      const remainingStr = remainingFrom100.toFixed(2).padStart(9);
      
      console.log(`| ${teamName} | ${purseStr} | ${boughtStr} | ${totalSpentStr} | ${hundredMinusStr} | ${remainingStr} |`);
      
      if (Math.abs(remainingFrom100) > 0.01) { // More than 0.01 Cr difference
        usersWithDifference++;
      }
      
      totalUsers++;
    }
    
    console.log('='.repeat(100));
    console.log(`📊 SUMMARY:`);
    console.log(`  - Total users processed: ${totalUsers}`);
    console.log(`  - Users with difference > ₹0.01 Cr: ${usersWithDifference}`);
    console.log(`  - Users with correct balance: ${totalUsers - usersWithDifference}`);
    console.log('='.repeat(100));
    
  } catch (error) {
    console.error('❌ Error in checkUserPurseDifference:', error);
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await checkUserPurseDifference();
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
