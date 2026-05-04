#!/usr/bin/env node

/**
 * Fix Royals Duplicate Fixtures
 * 
 * This script consolidates fixtures for team name variations like:
 * - "ROYALS"
 * - "ROYALS 👑" 
 * - "ROYALS " (with trailing space)
 * 
 * Usage: node fix-royals-duplicates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Fixture = require('./models/Fixture');
const User = require('./models/User');

async function fixRoyalsDuplicates() {
  try {
    // Check if MONGO_URI is set
    if (!process.env.MONGO_URI) {
      console.error('❌ MONGO_URI environment variable is not set!');
      process.exit(1);
    }

    await mongoose.connect(
      process.env.MONGO_URI,
      process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : undefined
    );
    console.log('🔗 Connected to MongoDB');

    // Step 1: Find the current active Royals user
    console.log('\n🔍 Step 1: Finding current Royals user...');
    const royalsUser = await User.findOne({
      teamName: { $regex: 'royal', $options: 'i' },
      isActive: true,
      isAdmin: { $ne: true }
    });

    if (!royalsUser) {
      console.log('❌ No active Royals user found');
      await mongoose.disconnect();
      return;
    }

    console.log(`✅ Current Royals team name: "${royalsUser.teamName}"`);
    const currentTeamName = royalsUser.teamName;

    // Step 2: Find all Royals fixture variations
    console.log('\n🔍 Step 2: Finding all Royals fixtures...');
    const allRoyalsFixtures = await Fixture.find({
      $or: [
        { team1: { $regex: 'royal', $options: 'i' } },
        { team2: { $regex: 'royal', $options: 'i' } }
      ],
      isActive: true
    }).sort({ createdAt: 1 });

    console.log(`📊 Found ${allRoyalsFixtures.length} Royals fixtures`);

    // Step 3: Identify team name variations
    const royalsVariations = new Set();
    allRoyalsFixtures.forEach(fixture => {
      if (fixture.team1.toLowerCase().includes('royal')) {
        royalsVariations.add(fixture.team1);
      }
      if (fixture.team2.toLowerCase().includes('royal')) {
        royalsVariations.add(fixture.team2);
      }
    });

    console.log(`\n🏷️  Team name variations found (${royalsVariations.size}):`);
    Array.from(royalsVariations).forEach((variation, i) => {
      console.log(`  ${i+1}. "${variation}"`);
    });

    // Step 4: Group fixtures by opponent and find duplicates
    console.log('\n🔍 Step 3: Grouping fixtures by opponent...');
    const fixturesByOpponent = new Map();

    allRoyalsFixtures.forEach(fixture => {
      let opponent;
      let royalsTeamInFixture;
      
      if (fixture.team1.toLowerCase().includes('royal')) {
        royalsTeamInFixture = fixture.team1;
        opponent = fixture.team2;
      } else {
        royalsTeamInFixture = fixture.team2;
        opponent = fixture.team1;
      }

      if (!fixturesByOpponent.has(opponent)) {
        fixturesByOpponent.set(opponent, []);
      }

      fixturesByOpponent.get(opponent).push({
        fixture,
        royalsTeamInFixture,
        opponent
      });
    });

    // Step 5: Process duplicates
    console.log('\n🔍 Step 4: Processing duplicates...');
    let duplicateGroups = 0;
    let totalDuplicatesToDelete = 0;
    const fixturesToDelete = [];
    const fixturesToUpdate = [];

    fixturesByOpponent.forEach((fixtures, opponent) => {
      if (fixtures.length > 1) {
        duplicateGroups++;
        console.log(`\n⚔️  ${opponent}: ${fixtures.length} fixtures (DUPLICATE GROUP ${duplicateGroups})`);

        // Sort fixtures: completed first, then by creation date (newest first)
        fixtures.sort((a, b) => {
          if (a.fixture.winner && !b.fixture.winner) return -1;
          if (!a.fixture.winner && b.fixture.winner) return 1;
          return new Date(b.fixture.createdAt) - new Date(a.fixture.createdAt);
        });

        // Keep the first one (best priority), delete the rest
        const keepFixture = fixtures[0];
        console.log(`  ✅ KEEP: ${keepFixture.fixture.team1} vs ${keepFixture.fixture.team2} (Winner: ${keepFixture.fixture.winner || 'None'}, Created: ${keepFixture.fixture.createdAt.toISOString().split('T')[0]})`);

        // Update the kept fixture to use current team name
        if (keepFixture.royalsTeamInFixture !== currentTeamName) {
          if (keepFixture.fixture.team1.toLowerCase().includes('royal')) {
            fixturesToUpdate.push({
              id: keepFixture.fixture._id,
              update: { team1: currentTeamName }
            });
          } else {
            fixturesToUpdate.push({
              id: keepFixture.fixture._id,
              update: { team2: currentTeamName }
            });
          }
        }

        // Mark others for deletion
        for (let i = 1; i < fixtures.length; i++) {
          const deleteFixture = fixtures[i];
          console.log(`  🗑️  DELETE: ${deleteFixture.fixture.team1} vs ${deleteFixture.fixture.team2} (Winner: ${deleteFixture.fixture.winner || 'None'}, Created: ${deleteFixture.fixture.createdAt.toISOString().split('T')[0]})`);
          fixturesToDelete.push(deleteFixture.fixture._id);
          totalDuplicatesToDelete++;
        }
      } else {
        // Single fixture - just update team name if needed
        const singleFixture = fixtures[0];
        if (singleFixture.royalsTeamInFixture !== currentTeamName) {
          if (singleFixture.fixture.team1.toLowerCase().includes('royal')) {
            fixturesToUpdate.push({
              id: singleFixture.fixture._id,
              update: { team1: currentTeamName }
            });
          } else {
            fixturesToUpdate.push({
              id: singleFixture.fixture._id,
              update: { team2: currentTeamName }
            });
          }
        }
      }
    });

    // Step 6: Summary and execution
    console.log(`\n📋 SUMMARY:`);
    console.log(`  - Total Royals fixtures: ${allRoyalsFixtures.length}`);
    console.log(`  - Team name variations: ${royalsVariations.size}`);
    console.log(`  - Opponents with duplicates: ${duplicateGroups}`);
    console.log(`  - Fixtures to delete: ${totalDuplicatesToDelete}`);
    console.log(`  - Fixtures to update team name: ${fixturesToUpdate.length}`);
    console.log(`  - Final expected fixtures: ${fixturesByOpponent.size}`);

    // Execute deletions
    if (fixturesToDelete.length > 0) {
      console.log(`\n🗑️  Deleting ${fixturesToDelete.length} duplicate fixtures...`);
      const deleteResult = await Fixture.deleteMany({ _id: { $in: fixturesToDelete } });
      console.log(`✅ Deleted ${deleteResult.deletedCount} fixtures`);
    }

    // Execute updates
    if (fixturesToUpdate.length > 0) {
      console.log(`\n📝 Updating ${fixturesToUpdate.length} fixtures with current team name...`);
      for (const update of fixturesToUpdate) {
        await Fixture.updateOne({ _id: update.id }, update.update);
      }
      console.log(`✅ Updated ${fixturesToUpdate.length} fixtures`);
    }

    // Final verification
    const finalRoyalsFixtures = await Fixture.find({
      $or: [
        { team1: currentTeamName },
        { team2: currentTeamName }
      ],
      isActive: true
    });

    console.log(`\n🎉 FINAL RESULT:`);
    console.log(`  - Royals fixtures after cleanup: ${finalRoyalsFixtures.length}`);
    console.log(`  - All fixtures now use team name: "${currentTeamName}"`);

    if (finalRoyalsFixtures.length === fixturesByOpponent.size) {
      console.log(`✅ SUCCESS: No more duplicates! Royals now has exactly one fixture per opponent.`);
    } else {
      console.log(`⚠️  Warning: Expected ${fixturesByOpponent.size} fixtures but found ${finalRoyalsFixtures.length}`);
    }

  } catch (error) {
    console.error('❌ Error during Royals fixtures cleanup:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the fix
fixRoyalsDuplicates().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('❌ Fix failed:', error);
  process.exit(1);
});
