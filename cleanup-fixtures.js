#!/usr/bin/env node

/**
 * Fixture Cleanup Utility
 * 
 * This script cleans up duplicate fixtures that may have been created
 * when team names were changed. Run this script if you're experiencing
 * issues with duplicate fixtures or trophy hall display problems.
 * 
 * Usage: node cleanup-fixtures.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Fixture = require('./models/Fixture');

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

async function cleanupFixtures() {
  try {
    // Check if MONGO_URI is set
    if (!process.env.MONGO_URI) {
      console.error('❌ MONGO_URI environment variable is not set!');
      console.log('📝 Please create a .env file with MONGO_URI=mongodb://localhost:27017');
      console.log('   Or set the environment variable: export MONGO_URI="mongodb://localhost:27017"');
      process.exit(1);
    }

    // Connect to database using the same configuration as server
    const mongooseOptions = process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : undefined;

    console.log(`🔗 Connecting to: ${process.env.MONGO_URI}`);
    await mongoose.connect(process.env.MONGO_URI, mongooseOptions);

    console.log('🔗 Connected to MongoDB');
    console.log('🧹 Starting fixture cleanup...');

    // Get all active fixtures (optionally scoped by tournamentId)
    const fixtureFilter = tournamentId ? { isActive: true, tournamentId } : { isActive: true };
    const existingFixtures = await Fixture.find(fixtureFilter);
    console.log(`📊 Found ${existingFixtures.length} active fixtures`);

    const fixtureMap = new Map();
    const duplicatesToDelete = [];
    let duplicatePairs = 0;

    for (const fixture of existingFixtures) {
      const scopeKey = tournamentId ? String(tournamentId) : String(fixture.tournamentId || 'global');
      const sortedKey = `${scopeKey}:${[fixture.team1, fixture.team2].sort().join('-')}`;
      
      if (fixtureMap.has(sortedKey)) {
        duplicatePairs++;
        const existingFixture = fixtureMap.get(sortedKey);
        
        console.log(`🔍 Duplicate found: ${fixture.team1} vs ${fixture.team2}`);
        console.log(`  - Existing: ID ${existingFixture._id}, Winner: ${existingFixture.winner || 'none'}, Created: ${existingFixture.createdAt}`);
        console.log(`  - Duplicate: ID ${fixture._id}, Winner: ${fixture.winner || 'none'}, Created: ${fixture.createdAt}`);
        
        // Priority logic: Keep the fixture with a winner, or the newer one if both have/don't have winners
        if (existingFixture.winner && !fixture.winner) {
          console.log(`  ✅ Keeping existing (has winner), deleting duplicate`);
          duplicatesToDelete.push(fixture._id);
        } else if (!existingFixture.winner && fixture.winner) {
          console.log(`  ✅ Keeping duplicate (has winner), deleting existing`);
          duplicatesToDelete.push(existingFixture._id);
          fixtureMap.set(sortedKey, fixture);
        } else if (!existingFixture.winner && !fixture.winner) {
          // Neither has winner, keep the newer one
          if (fixture.createdAt > existingFixture.createdAt) {
            console.log(`  ✅ Keeping duplicate (newer), deleting existing`);
            duplicatesToDelete.push(existingFixture._id);
            fixtureMap.set(sortedKey, fixture);
          } else {
            console.log(`  ✅ Keeping existing (newer), deleting duplicate`);
            duplicatesToDelete.push(fixture._id);
          }
        } else {
          // Both have winners, keep the older one (first completed match)
          if (fixture.createdAt > existingFixture.createdAt) {
            console.log(`  ✅ Keeping existing (first completed), deleting duplicate`);
            duplicatesToDelete.push(fixture._id);
          } else {
            console.log(`  ✅ Keeping duplicate (first completed), deleting existing`);
            duplicatesToDelete.push(existingFixture._id);
            fixtureMap.set(sortedKey, fixture);
          }
        }
      } else {
        fixtureMap.set(sortedKey, fixture);
      }
    }

    // Delete all identified duplicates
    let deletedCount = 0;
    if (duplicatesToDelete.length > 0) {
      const deleteResult = await Fixture.deleteMany({ _id: { $in: duplicatesToDelete } });
      deletedCount = deleteResult.deletedCount;
      console.log(`🗑️  Deleted ${deletedCount} duplicate fixtures`);
    } else {
      console.log('✨ No duplicate fixtures found!');
    }

    // Final summary
    const finalCount = await Fixture.countDocuments(fixtureFilter);
    console.log('\n📋 Cleanup Summary:');
    console.log(`  - Initial fixtures: ${existingFixtures.length}`);
    console.log(`  - Duplicate pairs found: ${duplicatePairs}`);
    console.log(`  - Fixtures deleted: ${deletedCount}`);
    console.log(`  - Final fixture count: ${finalCount}`);
    console.log(`  - Unique match pairs: ${fixtureMap.size}`);

    if (deletedCount > 0) {
      console.log('\n✅ Fixture cleanup completed successfully!');
      console.log('   Your trophy hall and fixture list should now display correctly.');
    } else {
      console.log('\n✅ Database is clean - no duplicates found.');
    }

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the cleanup
cleanupFixtures().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('❌ Cleanup failed:', error);
  process.exit(1);
});
