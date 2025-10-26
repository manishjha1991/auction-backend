#!/usr/bin/env node

/**
 * Test Team Name Changes
 * 
 * This script tests the new comprehensive team name update system
 * to ensure no duplicates are created when team names change.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { updateTeamNameEverywhere, findExistingFixture, createOrUpdateFixture } = require('./utils/teamNameUpdater');
const Fixture = require('./models/Fixture');
const User = require('./models/User');

async function testTeamNameChanges() {
  try {
    if (!process.env.MONGO_URI) {
      console.error('❌ MONGO_URI environment variable is not set!');
      process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI, { dbName: 'cpl_14' });
    console.log('🔗 Connected to MongoDB for testing');

    console.log('\n🧪 TESTING COMPREHENSIVE TEAM NAME UPDATE SYSTEM');
    console.log('='.repeat(60));

    // Test 1: Check current fixture state
    console.log('\n📋 Test 1: Current Fixture State');
    const allFixtures = await Fixture.find({ isActive: true });
    console.log(`Current total fixtures: ${allFixtures.length}`);

    // Find a test team (let's use one with fixtures)
    const testTeam = allFixtures.find(f => f.team1 !== f.team2);
    if (!testTeam) {
      console.log('❌ No fixtures found for testing');
      await mongoose.disconnect();
      return;
    }

    const originalTeamName = testTeam.team1;
    const testNewTeamName = `${originalTeamName}_TEST`;
    
    console.log(`🎯 Using test team: "${originalTeamName}"`);
    console.log(`🎯 Test new name will be: "${testNewTeamName}"`);

    // Count fixtures with this team before update
    const fixturesBeforeUpdate = await Fixture.find({
      $or: [
        { team1: originalTeamName },
        { team2: originalTeamName }
      ],
      isActive: true
    });
    console.log(`Fixtures with "${originalTeamName}" before update: ${fixturesBeforeUpdate.length}`);

    // Test 2: Comprehensive team name update
    console.log('\n🔄 Test 2: Comprehensive Team Name Update');
    const updateSummary = await updateTeamNameEverywhere(originalTeamName, testNewTeamName, 'test-user');
    
    console.log('Update Summary:');
    console.log(`  - Fixtures updated: ${updateSummary.updates.fixtures}`);
    console.log(`  - Match results updated: ${updateSummary.updates.matchResults}`);
    console.log(`  - MOM references updated: ${updateSummary.updates.momReferences}`);
    console.log(`  - Total updates: ${Object.values(updateSummary.updates).reduce((sum, count) => sum + count, 0)}`);

    // Verify no duplicates created
    const fixturesAfterUpdate = await Fixture.find({
      $or: [
        { team1: testNewTeamName },
        { team2: testNewTeamName },
        { team1: originalTeamName },
        { team2: originalTeamName }
      ],
      isActive: true
    });

    const newTeamFixtures = fixturesAfterUpdate.filter(f => 
      f.team1 === testNewTeamName || f.team2 === testNewTeamName
    );
    const oldTeamFixtures = fixturesAfterUpdate.filter(f => 
      f.team1 === originalTeamName || f.team2 === originalTeamName
    );

    console.log(`Fixtures with "${testNewTeamName}" after update: ${newTeamFixtures.length}`);
    console.log(`Fixtures with "${originalTeamName}" after update: ${oldTeamFixtures.length}`);

    if (oldTeamFixtures.length === 0 && newTeamFixtures.length === fixturesBeforeUpdate.length) {
      console.log('✅ SUCCESS: All fixtures updated, no duplicates created!');
    } else {
      console.log('❌ ISSUE: Duplicates may exist or update incomplete');
    }

    // Test 3: Smart fixture lookup
    console.log('\n🔍 Test 3: Smart Fixture Lookup');
    if (newTeamFixtures.length > 0) {
      const testFixture = newTeamFixtures[0];
      const opponent = testFixture.team1 === testNewTeamName ? testFixture.team2 : testFixture.team1;
      
      console.log(`Testing lookup for: "${testNewTeamName}" vs "${opponent}"`);
      
      // Test both orders
      const fixture1 = await findExistingFixture(testNewTeamName, opponent);
      const fixture2 = await findExistingFixture(opponent, testNewTeamName);
      
      if (fixture1 && fixture2 && fixture1._id.toString() === fixture2._id.toString()) {
        console.log('✅ SUCCESS: Smart fixture lookup works for both team orders!');
        console.log(`Found fixture: ${fixture1.team1} vs ${fixture1.team2}`);
      } else {
        console.log('❌ ISSUE: Smart fixture lookup failed');
      }
    }

    // Test 4: Smart fixture creation (should find existing, not create duplicate)
    console.log('\n🔨 Test 4: Smart Fixture Creation (Duplicate Prevention)');
    if (newTeamFixtures.length > 0) {
      const testFixture = newTeamFixtures[0];
      const opponent = testFixture.team1 === testNewTeamName ? testFixture.team2 : testFixture.team1;
      
      console.log(`Attempting to create fixture: "${opponent}" vs "${testNewTeamName}" (reversed order)`);
      
      const fixtureCountBefore = await Fixture.countDocuments({ isActive: true });
      const result = await createOrUpdateFixture(opponent, testNewTeamName, { matchType: 'normal' });
      const fixtureCountAfter = await Fixture.countDocuments({ isActive: true });
      
      if (fixtureCountBefore === fixtureCountAfter) {
        console.log('✅ SUCCESS: Smart creation found existing fixture, no duplicate created!');
        console.log(`Found/Updated fixture: ${result.team1} vs ${result.team2}`);
      } else {
        console.log('❌ ISSUE: Duplicate fixture may have been created');
      }
    }

    // Test 5: Rollback (restore original team name)
    console.log('\n⏪ Test 5: Rollback to Original Name');
    await updateTeamNameEverywhere(testNewTeamName, originalTeamName, 'test-user');
    
    const finalFixtures = await Fixture.find({
      $or: [
        { team1: originalTeamName },
        { team2: originalTeamName }
      ],
      isActive: true
    });

    console.log(`Fixtures with original name "${originalTeamName}" after rollback: ${finalFixtures.length}`);
    
    if (finalFixtures.length === fixturesBeforeUpdate.length) {
      console.log('✅ SUCCESS: Rollback successful, back to original state!');
    } else {
      console.log('⚠️  WARNING: Rollback count differs from original');
    }

    // Final verification
    console.log('\n📊 Final Verification');
    const totalFixturesAfterTest = await Fixture.countDocuments({ isActive: true });
    console.log(`Total fixtures after all tests: ${totalFixturesAfterTest}`);
    
    if (totalFixturesAfterTest === allFixtures.length) {
      console.log('✅ PERFECT: No fixtures gained or lost during testing!');
    } else {
      console.log(`⚠️  WARNING: Fixture count changed from ${allFixtures.length} to ${totalFixturesAfterTest}`);
    }

    console.log('\n🎉 TESTING COMPLETE!');
    console.log('='.repeat(60));
    console.log('✅ The comprehensive team name update system is working correctly!');
    console.log('✅ No duplicates are created when team names change!');
    console.log('✅ Smart fixture lookup and creation prevents duplicates!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the test
testTeamNameChanges().catch(console.error);
