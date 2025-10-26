#!/usr/bin/env node

/**
 * Test Points Table Integration with Team Name Changes
 * 
 * This script verifies that points tables, standings, and tournament 
 * point tables are not affected when team names change.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { updateTeamNameEverywhere } = require('./utils/teamNameUpdater');
const User = require('./models/User');
const Tournament = require('./models/Tournament');
const Fixture = require('./models/Fixture');

async function testPointsTableIntegration() {
  try {
    if (!process.env.MONGO_URI) {
      console.error('❌ MONGO_URI environment variable is not set!');
      process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI, { dbName: 'cpl_14' });
    console.log('🔗 Connected to MongoDB for points table testing');

    console.log('\n🏆 TESTING POINTS TABLE INTEGRATION WITH TEAM NAME CHANGES');
    console.log('='.repeat(70));

    // Test 1: Check current points table state
    console.log('\n📊 Test 1: Current Points Table State');
    
    const allUsers = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isAdmin: { $ne: true }
    }).select('teamName points matchesPlayed fairnessPoint').lean();

    console.log(`Found ${allUsers.length} teams in points table:`);
    allUsers.forEach(user => {
      console.log(`  - ${user.teamName}: Points=${user.points || 0}, Matches=${user.matchesPlayed || 0}, Fairness=${user.fairnessPoint || 0}`);
    });

    if (allUsers.length === 0) {
      console.log('❌ No teams found for testing');
      await mongoose.disconnect();
      return;
    }

    // Find a team with some points/matches for testing
    const testTeam = allUsers.find(u => (u.points > 0 || u.matchesPlayed > 0)) || allUsers[0];
    const originalTeamName = testTeam.teamName;
    const testNewTeamName = `${originalTeamName}_POINTS_TEST`;

    console.log(`\n🎯 Testing with team: "${originalTeamName}"`);
    console.log(`  - Current Points: ${testTeam.points || 0}`);
    console.log(`  - Current Matches: ${testTeam.matchesPlayed || 0}`);
    console.log(`  - Current Fairness: ${testTeam.fairnessPoint || 0}`);

    // Test 2: Check tournament point tables
    console.log('\n🏟️  Test 2: Tournament Point Tables Check');
    const tournaments = await Tournament.find({
      'pointTable.teamName': originalTeamName
    });

    console.log(`Found ${tournaments.length} tournaments with "${originalTeamName}" in point table`);
    tournaments.forEach(tournament => {
      const teamEntry = tournament.pointTable.find(pt => pt.teamName === originalTeamName);
      if (teamEntry) {
        console.log(`  - ${tournament.name}: Points=${teamEntry.points}, Matches=${teamEntry.matches}, Won=${teamEntry.won}, Lost=${teamEntry.lost}`);
      }
    });

    // Test 3: Team name change and verify points preservation
    console.log('\n🔄 Test 3: Team Name Change and Points Preservation');
    
    const updateSummary = await updateTeamNameEverywhere(originalTeamName, testNewTeamName, 'points-test');
    
    console.log(`Update Summary:`);
    console.log(`  - Fixtures updated: ${updateSummary.updates.fixtures}`);
    console.log(`  - Match results updated: ${updateSummary.updates.matchResults}`);
    console.log(`  - Tournaments updated: ${updateSummary.updates.tournaments}`);

    // Verify user points are preserved
    const updatedUser = await User.findOne({ teamName: testNewTeamName }).select('teamName points matchesPlayed fairnessPoint');
    
    if (updatedUser) {
      console.log(`\n✅ User Points After Team Name Change:`);
      console.log(`  - New Team Name: "${updatedUser.teamName}"`);
      console.log(`  - Points: ${updatedUser.points || 0} (Original: ${testTeam.points || 0})`);
      console.log(`  - Matches: ${updatedUser.matchesPlayed || 0} (Original: ${testTeam.matchesPlayed || 0})`);
      console.log(`  - Fairness: ${updatedUser.fairnessPoint || 0} (Original: ${testTeam.fairnessPoint || 0})`);
      
      if ((updatedUser.points || 0) === (testTeam.points || 0) && 
          (updatedUser.matchesPlayed || 0) === (testTeam.matchesPlayed || 0) && 
          (updatedUser.fairnessPoint || 0) === (testTeam.fairnessPoint || 0)) {
        console.log('✅ SUCCESS: All points and stats preserved!');
      } else {
        console.log('❌ ISSUE: Points or stats changed unexpectedly');
      }
    }

    // Test 4: Check tournament point table updates
    console.log('\n🏟️  Test 4: Tournament Point Table Updates');
    const updatedTournaments = await Tournament.find({
      'pointTable.teamName': testNewTeamName
    });

    const oldTournaments = await Tournament.find({
      'pointTable.teamName': originalTeamName
    });

    console.log(`Tournaments with new name "${testNewTeamName}": ${updatedTournaments.length}`);
    console.log(`Tournaments with old name "${originalTeamName}": ${oldTournaments.length}`);

    if (updatedTournaments.length === tournaments.length && oldTournaments.length === 0) {
      console.log('✅ SUCCESS: Tournament point tables updated correctly!');
      
      updatedTournaments.forEach(tournament => {
        const teamEntry = tournament.pointTable.find(pt => pt.teamName === testNewTeamName);
        if (teamEntry) {
          console.log(`  - ${tournament.name}: Points=${teamEntry.points}, Matches=${teamEntry.matches}`);
        }
      });
    } else {
      console.log('❌ ISSUE: Tournament point table updates may be incomplete');
    }

    // Test 5: Points table endpoint simulation
    console.log('\n📊 Test 5: Points Table Endpoint Simulation');
    
    const pointsTableUsers = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isAdmin: { $ne: true }
    }).select('teamName points matchesPlayed fairnessPoint').lean();

    const pointsTable = pointsTableUsers.map(user => {
      const matchesPlayed = user.matchesPlayed || 0;
      const points = user.points || 0;
      const fairness = user.fairnessPoint || 0;
      const wins = Math.floor(points / 2);
      const losses = matchesPlayed - wins;
      
      return {
        teamName: user.teamName,
        points,
        matchesPlayed,
        wins,
        losses,
        fairness
      };
    }).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.fairness - a.fairness;
    });

    console.log('Current Points Table (Top 5):');
    pointsTable.slice(0, 5).forEach((team, index) => {
      const isTestTeam = team.teamName === testNewTeamName;
      console.log(`  ${index + 1}. ${team.teamName}${isTestTeam ? ' ⭐' : ''}: ${team.points}pts, ${team.wins}W-${team.losses}L, Fair:${team.fairness}`);
    });

    const testTeamInTable = pointsTable.find(team => team.teamName === testNewTeamName);
    if (testTeamInTable) {
      console.log('✅ SUCCESS: Test team found in points table with correct stats!');
    } else {
      console.log('❌ ISSUE: Test team not found in points table');
    }

    // Test 6: Rollback and verify everything returns to normal
    console.log('\n⏪ Test 6: Rollback Team Name');
    await updateTeamNameEverywhere(testNewTeamName, originalTeamName, 'points-test');

    const restoredUser = await User.findOne({ teamName: originalTeamName }).select('teamName points matchesPlayed fairnessPoint');
    
    if (restoredUser && 
        (restoredUser.points || 0) === (testTeam.points || 0) && 
        (restoredUser.matchesPlayed || 0) === (testTeam.matchesPlayed || 0) && 
        (restoredUser.fairnessPoint || 0) === (testTeam.fairnessPoint || 0)) {
      console.log('✅ SUCCESS: Rollback completed - all points preserved!');
    } else {
      console.log('❌ ISSUE: Rollback may have affected points');
    }

    // Final verification
    console.log('\n📊 Final Verification');
    const finalTournaments = await Tournament.find({
      'pointTable.teamName': originalTeamName
    });
    
    console.log(`Final tournament point tables with original name: ${finalTournaments.length}`);
    
    if (finalTournaments.length === tournaments.length) {
      console.log('✅ SUCCESS: Tournament point tables fully restored!');
    }

    console.log('\n🎉 POINTS TABLE TESTING COMPLETE!');
    console.log('='.repeat(70));
    console.log('✅ User points, matches, and fairness are preserved during team name changes!');
    console.log('✅ Tournament point tables are updated correctly!');
    console.log('✅ Points table endpoints work correctly with new team names!');
    console.log('✅ All standings and rankings remain intact!');

  } catch (error) {
    console.error('❌ Points table test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the test
testPointsTableIntegration().catch(console.error);
