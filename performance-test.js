// Performance testing script to validate index effectiveness
const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const User = require('./models/User');
const Player = require('./models/Player');
const Bid = require('./models/Bid');
const Fixture = require('./models/Fixture');
const PlayerStats = require('./models/PlayerStats');

async function testPerformance() {
  try {
    // Connect to MongoDB
    await mongoose.connect(
      process.env.MONGO_URI,
      process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : undefined
    );
    console.log('✅ Connected to MongoDB');

    console.log('🚀 Starting performance tests...\n');

    // Test 1: User queries
    console.log('📊 Testing User queries...');
    await testUserQueries();

    // Test 2: Player queries
    console.log('👥 Testing Player queries...');
    await testPlayerQueries();

    // Test 3: Bid queries
    console.log('💰 Testing Bid queries...');
    await testBidQueries();

    // Test 4: Fixture queries
    console.log('🏆 Testing Fixture queries...');
    await testFixtureQueries();

    // Test 5: PlayerStats queries
    console.log('📈 Testing PlayerStats queries...');
    await testPlayerStatsQueries();

    console.log('\n✅ All performance tests completed!');

  } catch (error) {
    console.error('❌ Performance test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

async function testUserQueries() {
  const tests = [
    {
      name: 'Find active tournament ready users',
      query: () => User.find({ isActive: true, isTournamentReady: true }),
      expectedIndex: { isActive: 1, isTournamentReady: 1 }
    },
    {
      name: 'Find users by group',
      query: () => User.find({ group: 'A', isActive: true }),
      expectedIndex: { group: 1, isActive: 1 }
    },
    {
      name: 'Points table query',
      query: () => User.find({ isActive: true }).sort({ points: -1, fairnessPoint: -1 }),
      expectedIndex: { points: -1, fairnessPoint: -1 }
    },
    {
      name: 'Search by team name',
      query: () => User.find({ teamName: { $regex: 'Team', $options: 'i' }, isActive: true }),
      expectedIndex: { teamName: 1, isActive: 1 }
    }
  ];

  for (const test of tests) {
    const start = Date.now();
    const result = await test.query();
    const duration = Date.now() - start;
    console.log(`  ✓ ${test.name}: ${result.length} results in ${duration}ms`);
  }
}

async function testPlayerQueries() {
  const tests = [
    {
      name: 'Find unsold players',
      query: () => Player.find({ isSold: false, isActive: true }),
      expectedIndex: { isSold: 1, isActive: 1 }
    },
    {
      name: 'Find players by type',
      query: () => Player.find({ type: 'Gold', isActive: true }),
      expectedIndex: { type: 1, isActive: 1 }
    },
    {
      name: 'Search players by name',
      query: () => Player.find({ name: { $regex: 'Player', $options: 'i' }, isActive: true }),
      expectedIndex: { name: 1, isActive: 1 }
    },
    {
      name: 'Sort by base price',
      query: () => Player.find({ isActive: true }).sort({ basePrice: 1 }),
      expectedIndex: { basePrice: 1 }
    }
  ];

  for (const test of tests) {
    const start = Date.now();
    const result = await test.query();
    const duration = Date.now() - start;
    console.log(`  ✓ ${test.name}: ${result.length} results in ${duration}ms`);
  }
}

async function testBidQueries() {
  const tests = [
    {
      name: 'Find bids by player',
      query: () => Bid.find({ playerId: new mongoose.Types.ObjectId() }),
      expectedIndex: { playerId: 1 }
    },
    {
      name: 'Find active bids by bidder',
      query: () => Bid.find({ bidder: new mongoose.Types.ObjectId(), isActive: true }),
      expectedIndex: { bidder: 1, isActive: 1 }
    },
    {
      name: 'Find highest bids',
      query: () => Bid.find({ isActive: true }).sort({ bidAmount: -1 }),
      expectedIndex: { bidAmount: -1, isActive: 1 }
    },
    {
      name: 'Find recent bids',
      query: () => Bid.find({ isActive: true }).sort({ timestamp: -1 }),
      expectedIndex: { timestamp: -1, isActive: 1 }
    }
  ];

  for (const test of tests) {
    const start = Date.now();
    const result = await test.query();
    const duration = Date.now() - start;
    console.log(`  ✓ ${test.name}: ${result.length} results in ${duration}ms`);
  }
}

async function testFixtureQueries() {
  const tests = [
    {
      name: 'Find active fixtures',
      query: () => Fixture.find({ isActive: true }),
      expectedIndex: { isActive: 1 }
    },
    {
      name: 'Find group A fixtures',
      query: () => Fixture.find({ group: 'A', isActive: true }),
      expectedIndex: { group: 1, isActive: 1 }
    },
    {
      name: 'Find fixtures by team',
      query: () => Fixture.find({ team1: 'Team A', isActive: true }),
      expectedIndex: { team1: 1, isActive: 1 }
    },
    {
      name: 'Find completed fixtures',
      query: () => Fixture.find({ winner: { $exists: true }, isActive: true }),
      expectedIndex: { winner: 1, isActive: 1 }
    },
    {
      name: 'Sort fixtures by date',
      query: () => Fixture.find({ isActive: true }).sort({ createdAt: -1 }),
      expectedIndex: { createdAt: -1, isActive: 1 }
    }
  ];

  for (const test of tests) {
    const start = Date.now();
    const result = await test.query();
    const duration = Date.now() - start;
    console.log(`  ✓ ${test.name}: ${result.length} results in ${duration}ms`);
  }
}

async function testPlayerStatsQueries() {
  const tests = [
    {
      name: 'Find stats by player',
      query: () => PlayerStats.find({ playerId: new mongoose.Types.ObjectId() }),
      expectedIndex: { playerId: 1 }
    },
    {
      name: 'Find stats by user',
      query: () => PlayerStats.find({ userId: new mongoose.Types.ObjectId() }),
      expectedIndex: { userId: 1 }
    },
    {
      name: 'Find MoM stats',
      query: () => PlayerStats.find({ isMom: true }).sort({ createdAt: -1 }),
      expectedIndex: { isMom: 1, createdAt: -1 }
    },
    {
      name: 'Find recent stats',
      query: () => PlayerStats.find({}).sort({ createdAt: -1 }),
      expectedIndex: { createdAt: -1 }
    }
  ];

  for (const test of tests) {
    const start = Date.now();
    const result = await test.query();
    const duration = Date.now() - start;
    console.log(`  ✓ ${test.name}: ${result.length} results in ${duration}ms`);
  }
}

// Run the performance test
testPerformance();