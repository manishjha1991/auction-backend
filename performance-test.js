const mongoose = require('mongoose');
const Player = require('./models/Player');
const UserPlayer = require('./models/UserPlayer');
const Bid = require('./models/Bid');

// Performance testing script for trade-related endpoints
async function testPerformance() {
  try {
    console.log('🔍 Testing API Performance...\n');
    
    // Test 1: Players data endpoint (old vs new approach)
    console.log('📊 Testing Players Data Endpoint:');
    
    const startTime = Date.now();
    
    // Simulate old approach (N+1 queries)
    const players = await Player.find({ isActive: true });
    let oldApproachTime = Date.now();
    
    for (const player of players.slice(0, 5)) { // Test with first 5 players
      await UserPlayer.findOne({ playerId: player._id, isActive: true }).populate('userId', 'name teamName');
      await Bid.findOne({ playerId: player._id }).populate('bidder', 'name teamName').sort({ bidAmount: -1 });
    }
    
    const oldTotalTime = Date.now() - startTime;
    console.log(`   Old approach (N+1 queries): ${oldTotalTime}ms`);
    
    // Test new aggregation approach
    const newStartTime = Date.now();
    await Player.aggregate([
      { $match: { isActive: true } },
      {
        $lookup: {
          from: 'userplayers',
          let: { playerId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$playerId', '$$playerId'] }, { $eq: ['$isActive', true] }] } } },
            { $limit: 1 }
          ],
          as: 'userPlayer'
        }
      },
      {
        $lookup: {
          from: 'users',
          let: { userId: { $arrayElemAt: ['$userPlayer.userId', 0] } },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$userId'] } } },
            { $project: { name: 1, teamName: 1 } }
          ],
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'bids',
          let: { playerId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$playerId', '$$playerId'] } } },
            { $sort: { bidAmount: -1 } },
            { $limit: 1 },
            {
              $lookup: {
                from: 'users',
                let: { bidderId: '$bidder' },
                pipeline: [
                  { $match: { $expr: { $eq: ['$_id', '$$bidderId'] } } },
                  { $project: { name: 1, teamName: 1 } }
                ],
                as: 'bidder'
              }
            }
          ],
          as: 'highestBid'
        }
      }
    ]);
    
    const newTotalTime = Date.now() - newStartTime;
    console.log(`   New approach (aggregation): ${newTotalTime}ms`);
    
    const improvement = ((oldTotalTime - newTotalTime) / oldTotalTime * 100).toFixed(1);
    console.log(`   Performance improvement: ${improvement}%\n`);
    
    // Test 2: Database indexes
    console.log('🗄️  Testing Database Indexes:');
    
    const indexStartTime = Date.now();
    await UserPlayer.find({ isActive: true }).limit(100);
    const indexTime = Date.now() - indexStartTime;
    console.log(`   UserPlayer query with indexes: ${indexTime}ms`);
    
    // Test 3: Trade queries
    console.log('🔄 Testing Trade Queries:');
    
    const tradeStartTime = Date.now();
    await Player.find({ isActive: true, isSold: true }).limit(50);
    const tradeTime = Date.now() - tradeStartTime;
    console.log(`   Sold players query: ${tradeTime}ms`);
    
    console.log('\n✅ Performance testing completed!');
    
  } catch (error) {
    console.error('❌ Performance test failed:', error);
  }
}

// Run performance test if this file is executed directly
if (require.main === module) {
  // Connect to MongoDB first
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/your-database')
    .then(() => {
      console.log('📡 Connected to MongoDB');
      return testPerformance();
    })
    .then(() => {
      console.log('🏁 Performance test finished');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Error:', error);
      process.exit(1);
    });
}

module.exports = { testPerformance };
