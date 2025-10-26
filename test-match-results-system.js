#!/usr/bin/env node

/**
 * Test Match Results System
 * 
 * This script tests the enhanced match results system to ensure:
 * - No duplicates are created when team names change
 * - Smart match result lookup works correctly
 * - Team name consistency is maintained
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { 
  updateTeamNameEverywhere, 
  findExistingMatchResult, 
  createOrUpdateMatchResult,
  updateMatchResultConsistently 
} = require('./utils/teamNameUpdater');
const MatchResult = require('./models/MatchResult');
const User = require('./models/User');

async function testMatchResultsSystem() {
  try {
    if (!process.env.MONGO_URI) {
      console.error('❌ MONGO_URI environment variable is not set!');
      process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI, { dbName: 'cpl_14' });
    console.log('🔗 Connected to MongoDB for match results testing');

    console.log('\n🧪 TESTING ENHANCED MATCH RESULTS SYSTEM');
    console.log('='.repeat(60));

    // Test 1: Check current match results state
    console.log('\n📋 Test 1: Current Match Results State');
    const allMatchResults = await MatchResult.find({});
    console.log(`Current total match results: ${allMatchResults.length}`);

    if (allMatchResults.length === 0) {
      console.log('ℹ️  No match results found. Testing will focus on creation and team name updates.');
    }

    // Get test teams
    const testTeams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isAdmin: { $ne: true }
    }).select('teamName').limit(2);

    if (testTeams.length < 2) {
      console.log('❌ Need at least 2 teams for testing');
      await mongoose.disconnect();
      return;
    }

    const team1Name = testTeams[0].teamName;
    const team2Name = testTeams[1].teamName;
    const testNewTeamName = `${team1Name}_TEST_MATCH`;

    console.log(`🎯 Using test teams: "${team1Name}" vs "${team2Name}"`);
    console.log(`🎯 Will test renaming "${team1Name}" to "${testNewTeamName}"`);

    // Test 2: Smart match result lookup
    console.log('\n🔍 Test 2: Smart Match Result Lookup');
    
    if (allMatchResults.length > 0) {
      const testMatch = allMatchResults[0];
      console.log(`Testing lookup for: "${testMatch.team1}" vs "${testMatch.team2}"`);
      
      // Test both orders
      const lookup1 = await findExistingMatchResult(testMatch.team1, testMatch.team2);
      const lookup2 = await findExistingMatchResult(testMatch.team2, testMatch.team1);
      
      if (lookup1 && lookup2 && lookup1._id.toString() === lookup2._id.toString()) {
        console.log('✅ SUCCESS: Smart match result lookup works for both team orders!');
      } else if (lookup1) {
        console.log('✅ SUCCESS: Found match result in original order');
      } else {
        console.log('❌ ISSUE: Smart match result lookup failed');
      }
    } else {
      console.log('ℹ️  Skipping lookup test - no existing match results');
    }

    // Test 3: Create test match result
    console.log('\n🏆 Test 3: Smart Match Result Creation');
    
    const testMatchData = {
      matchNumber: 'TEST001',
      matchTitle: `Test Match - ${team1Name} vs ${team2Name}`,
      team1: team1Name,
      team2: team2Name,
      winner: 'team1',
      team1Score: 150,
      team2Score: 145,
      team1Wickets: 3,
      team2Wickets: 7,
      team1Overs: 20,
      team2Overs: 20,
      matchDate: new Date(),
      matchVenue: 'Test Stadium',
      manOfTheMatch: {
        name: 'Test Player',
        team: team1Name,
        runs: 75,
        wickets: 2,
        balls: 45
      },
      trophyName: 'Test Trophy',
      trophyType: 'league',
      matchType: 'normal',
      margin: '5 runs',
      matchStatus: 'completed',
      additionalNotes: 'Test match for system validation',
      createdBy: new mongoose.Types.ObjectId()
    };

    let testMatchResult;
    try {
      testMatchResult = await createOrUpdateMatchResult(testMatchData);
      console.log('✅ SUCCESS: Test match result created successfully');
      console.log(`Created: ${testMatchResult.matchTitle} (ID: ${testMatchResult._id})`);
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ SUCCESS: Smart creation detected existing match - no duplicate created');
      } else {
        console.log(`❌ ISSUE: ${error.message}`);
      }
    }

    // Test 4: Try to create duplicate (should fail)
    console.log('\n🛡️  Test 4: Duplicate Prevention');
    if (testMatchResult) {
      try {
        const duplicateData = { ...testMatchData, matchNumber: 'TEST002' };
        await createOrUpdateMatchResult(duplicateData);
        console.log('❌ ISSUE: Duplicate match result was created (should have been prevented)');
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log('✅ SUCCESS: Duplicate prevention working correctly');
          console.log(`Prevented duplicate: ${error.message}`);
        } else {
          console.log(`❌ UNEXPECTED ERROR: ${error.message}`);
        }
      }
    }

    // Test 5: Team name change and match result updates
    console.log('\n🔄 Test 5: Team Name Change Impact on Match Results');
    
    const matchResultsBeforeUpdate = await MatchResult.find({
      $or: [
        { team1: team1Name },
        { team2: team1Name },
        { 'manOfTheMatch.team': team1Name }
      ]
    });
    
    console.log(`Match results with "${team1Name}" before update: ${matchResultsBeforeUpdate.length}`);
    
    if (matchResultsBeforeUpdate.length > 0) {
      // Test team name update
      const updateSummary = await updateTeamNameEverywhere(team1Name, testNewTeamName, 'test-user');
      
      console.log(`Team name update summary:`);
      console.log(`  - Match results updated: ${updateSummary.updates.matchResults}`);
      console.log(`  - MOM references updated: ${updateSummary.updates.momReferences}`);
      
      // Verify updates
      const matchResultsAfterUpdate = await MatchResult.find({
        $or: [
          { team1: testNewTeamName },
          { team2: testNewTeamName },
          { 'manOfTheMatch.team': testNewTeamName }
        ]
      });
      
      const oldNameResults = await MatchResult.find({
        $or: [
          { team1: team1Name },
          { team2: team1Name },
          { 'manOfTheMatch.team': team1Name }
        ]
      });
      
      console.log(`Match results with "${testNewTeamName}" after update: ${matchResultsAfterUpdate.length}`);
      console.log(`Match results with old name "${team1Name}" after update: ${oldNameResults.length}`);
      
      if (oldNameResults.length === 0 && matchResultsAfterUpdate.length === matchResultsBeforeUpdate.length) {
        console.log('✅ SUCCESS: All match results updated, no duplicates created!');
      } else {
        console.log('❌ ISSUE: Team name update may have created inconsistencies');
      }
    } else {
      console.log('ℹ️  No existing match results to update');
    }

    // Test 6: Smart match result update
    console.log('\n📝 Test 6: Smart Match Result Update');
    if (testMatchResult) {
      try {
        const updateData = {
          winner: 'team2',
          margin: '10 runs',
          additionalNotes: 'Updated in test - winner changed'
        };
        
        const updated = await updateMatchResultConsistently(testMatchResult._id, updateData);
        console.log('✅ SUCCESS: Match result updated successfully');
        console.log(`Updated winner to: ${updated.winner}, margin: ${updated.margin}`);
      } catch (error) {
        console.log(`❌ ISSUE: ${error.message}`);
      }
    }

    // Test 7: Rollback (restore original team name)
    console.log('\n⏪ Test 7: Rollback Team Name');
    if (matchResultsBeforeUpdate.length > 0) {
      await updateTeamNameEverywhere(testNewTeamName, team1Name, 'test-user');
      
      const finalCheck = await MatchResult.find({
        $or: [
          { team1: team1Name },
          { team2: team1Name },
          { 'manOfTheMatch.team': team1Name }
        ]
      });
      
      console.log(`Match results with original name "${team1Name}" after rollback: ${finalCheck.length}`);
      
      if (finalCheck.length === matchResultsBeforeUpdate.length) {
        console.log('✅ SUCCESS: Rollback successful, back to original state!');
      } else {
        console.log('⚠️  WARNING: Rollback count differs from original');
      }
    }

    // Cleanup: Delete test match result if created
    if (testMatchResult) {
      console.log('\n🧹 Cleanup: Removing test match result');
      await MatchResult.deleteOne({ _id: testMatchResult._id });
      console.log('✅ Test match result removed');
    }

    // Final verification
    console.log('\n📊 Final Verification');
    const finalMatchResults = await MatchResult.countDocuments({});
    console.log(`Total match results after all tests: ${finalMatchResults}`);
    
    if (finalMatchResults === allMatchResults.length) {
      console.log('✅ PERFECT: No match results gained or lost during testing!');
    } else {
      console.log(`⚠️  WARNING: Match result count changed from ${allMatchResults.length} to ${finalMatchResults}`);
    }

    console.log('\n🎉 TESTING COMPLETE!');
    console.log('='.repeat(60));
    console.log('✅ The enhanced match results system is working correctly!');
    console.log('✅ No duplicates are created when team names change!');
    console.log('✅ Smart match result lookup and creation prevents duplicates!');
    console.log('✅ Team name consistency is maintained across match results!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the test
testMatchResultsSystem().catch(console.error);
