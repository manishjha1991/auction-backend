/**
 * Comprehensive Team Name Updater
 * 
 * This utility ensures that when a team name is changed, ALL references
 * across the entire system are updated consistently, preventing duplicates
 * and maintaining data integrity.
 */

const Fixture = require('../models/Fixture');
const MatchResult = require('../models/MatchResult');
const PlayoffFixture = require('../models/PlayoffFixture');
const Tournament = require('../models/Tournament');
const BidHistory = require('../models/BidHistory');
const Notification = require('../models/Notification');
const User = require('../models/User');

/**
 * Comprehensive team name update across all collections
 * @param {string} oldTeamName - The previous team name
 * @param {string} newTeamName - The new team name
 * @param {string} userId - The user ID making the change (for logging)
 * @returns {Object} Summary of all updates made
 */
async function updateTeamNameEverywhere(oldTeamName, newTeamName, userId = null) {
  const updateSummary = {
    oldTeamName,
    newTeamName,
    userId,
    timestamp: new Date(),
    updates: {
      fixtures: 0,
      matchResults: 0,
      playoffFixtures: 0,
      tournaments: 0,
      bidHistory: 0,
      notifications: 0,
      momReferences: 0
    },
    errors: []
  };

  console.log(`🔄 Starting comprehensive team name update: "${oldTeamName}" → "${newTeamName}"`);

  try {
    // 1. Update Fixtures (team1 and team2)
    console.log('📋 Updating fixtures...');
    const fixtureUpdate1 = await Fixture.updateMany(
      { team1: oldTeamName },
      { $set: { team1: newTeamName } }
    );
    const fixtureUpdate2 = await Fixture.updateMany(
      { team2: oldTeamName },
      { $set: { team2: newTeamName } }
    );
    updateSummary.updates.fixtures = fixtureUpdate1.modifiedCount + fixtureUpdate2.modifiedCount;
    console.log(`✅ Updated ${updateSummary.updates.fixtures} fixtures`);

    // 2. Update Match Results (team1, team2, and MOM team references)
    console.log('🏆 Updating match results...');
    const matchUpdate1 = await MatchResult.updateMany(
      { team1: oldTeamName },
      { $set: { team1: newTeamName } }
    );
    const matchUpdate2 = await MatchResult.updateMany(
      { team2: oldTeamName },
      { $set: { team2: newTeamName } }
    );
    const momUpdate = await MatchResult.updateMany(
      { 'manOfTheMatch.team': oldTeamName },
      { $set: { 'manOfTheMatch.team': newTeamName } }
    );
    updateSummary.updates.matchResults = matchUpdate1.modifiedCount + matchUpdate2.modifiedCount;
    updateSummary.updates.momReferences = momUpdate.modifiedCount;
    console.log(`✅ Updated ${updateSummary.updates.matchResults} match results and ${updateSummary.updates.momReferences} MOM references`);

    // 3. Update Playoff Fixtures (if they exist)
    console.log('🏆 Updating playoff fixtures...');
    try {
      const playoffUpdate1 = await PlayoffFixture.updateMany(
        { team1: oldTeamName },
        { $set: { team1: newTeamName } }
      );
      const playoffUpdate2 = await PlayoffFixture.updateMany(
        { team2: oldTeamName },
        { $set: { team2: newTeamName } }
      );
      // Also update winner field in playoff fixtures
      const playoffWinnerUpdate = await PlayoffFixture.updateMany(
        { winner: oldTeamName },
        { $set: { winner: newTeamName } }
      );
      updateSummary.updates.playoffFixtures = playoffUpdate1.modifiedCount + playoffUpdate2.modifiedCount + playoffWinnerUpdate.modifiedCount;
      console.log(`✅ Updated ${updateSummary.updates.playoffFixtures} playoff fixtures`);
    } catch (playoffError) {
      console.log('ℹ️  No playoff fixtures to update (model may not exist)');
      updateSummary.errors.push(`Playoff fixtures: ${playoffError.message}`);
    }

    // 4. Update Tournament fixtures and point tables (if they exist)
    console.log('🏟️  Updating tournament fixtures and point tables...');
    try {
      // Update tournament fixtures
      const tournamentFixtureUpdate = await Tournament.updateMany(
        {
          $or: [
            { 'tournamentFixtures.team1': oldTeamName },
            { 'tournamentFixtures.team2': oldTeamName },
            { 'subscribedTeams.teamName': oldTeamName }
          ]
        },
        {
          $set: {
            'tournamentFixtures.$[fixture1].team1': newTeamName,
            'tournamentFixtures.$[fixture2].team2': newTeamName,
            'subscribedTeams.$[team].teamName': newTeamName
          }
        },
        {
          arrayFilters: [
            { 'fixture1.team1': oldTeamName },
            { 'fixture2.team2': oldTeamName },
            { 'team.teamName': oldTeamName }
          ]
        }
      );

      // Update tournament point tables
      const tournamentPointTableUpdate = await Tournament.updateMany(
        { 'pointTable.teamName': oldTeamName },
        { $set: { 'pointTable.$.teamName': newTeamName } }
      );

      updateSummary.updates.tournaments = tournamentFixtureUpdate.modifiedCount + tournamentPointTableUpdate.modifiedCount;
      console.log(`✅ Updated ${tournamentFixtureUpdate.modifiedCount} tournament fixtures and ${tournamentPointTableUpdate.modifiedCount} tournament point tables`);
    } catch (tournamentError) {
      console.log('ℹ️  No tournament fixtures to update (model may not exist)');
      updateSummary.errors.push(`Tournaments: ${tournamentError.message}`);
    }

    // 5. Update Bid History (if team references exist)
    console.log('💰 Updating bid history...');
    try {
      const bidHistoryUpdate = await BidHistory.updateMany(
        { teamName: oldTeamName },
        { $set: { teamName: newTeamName } }
      );
      updateSummary.updates.bidHistory = bidHistoryUpdate.modifiedCount || 0;
      console.log(`✅ Updated ${updateSummary.updates.bidHistory} bid history records`);
    } catch (bidError) {
      console.log('ℹ️  No bid history to update');
      updateSummary.updates.bidHistory = 0;
      updateSummary.errors.push(`Bid History: ${bidError.message}`);
    }

    // 6. Update Notifications (if team references exist)
    console.log('🔔 Updating notifications...');
    try {
      // Find notifications containing the old team name
      const notificationsToUpdate = await Notification.find({
        message: { $regex: oldTeamName, $options: 'i' }
      });
      
      let updatedCount = 0;
      for (const notification of notificationsToUpdate) {
        const updatedMessage = notification.message.replace(
          new RegExp(oldTeamName, 'gi'), 
          newTeamName
        );
        await Notification.updateOne(
          { _id: notification._id },
          { $set: { message: updatedMessage } }
        );
        updatedCount++;
      }
      
      updateSummary.updates.notifications = updatedCount;
      console.log(`✅ Updated ${updateSummary.updates.notifications} notifications`);
    } catch (notificationError) {
      console.log('ℹ️  No notifications to update');
      updateSummary.errors.push(`Notifications: ${notificationError.message}`);
    }

    // Calculate total updates
    const totalUpdates = Object.values(updateSummary.updates).reduce((sum, count) => sum + count, 0);
    
    console.log(`\n🎉 TEAM NAME UPDATE COMPLETE!`);
    console.log(`📊 Summary of updates:`);
    console.log(`  - Fixtures: ${updateSummary.updates.fixtures}`);
    console.log(`  - Match Results: ${updateSummary.updates.matchResults}`);
    console.log(`  - MOM References: ${updateSummary.updates.momReferences}`);
    console.log(`  - Playoff Fixtures: ${updateSummary.updates.playoffFixtures}`);
    console.log(`  - Tournaments: ${updateSummary.updates.tournaments}`);
    console.log(`  - Bid History: ${updateSummary.updates.bidHistory}`);
    console.log(`  - Notifications: ${updateSummary.updates.notifications}`);
    console.log(`  - TOTAL UPDATES: ${totalUpdates}`);

    if (updateSummary.errors.length > 0) {
      console.log(`⚠️  Warnings/Errors: ${updateSummary.errors.length}`);
      updateSummary.errors.forEach(error => console.log(`    - ${error}`));
    }

    return updateSummary;

  } catch (error) {
    console.error(`❌ Critical error during team name update:`, error);
    updateSummary.errors.push(`Critical error: ${error.message}`);
    throw error;
  }
}

/**
 * Smart fixture lookup that finds fixtures regardless of team order or name variations
 * @param {string} team1 - First team name
 * @param {string} team2 - Second team name
 * @returns {Object|null} Found fixture or null
 */
async function findExistingFixture(team1, team2) {
  // Try to find fixture with either team order
  const fixture = await Fixture.findOne({
    $or: [
      { team1: team1, team2: team2 },
      { team1: team2, team2: team1 }
    ],
    isActive: true
  });

  if (fixture) {
    console.log(`🔍 Found existing fixture: ${fixture.team1} vs ${fixture.team2}`);
    return fixture;
  }

  return null;
}

/**
 * Smart fixture creation that prevents duplicates
 * @param {string} team1 - First team name
 * @param {string} team2 - Second team name
 * @param {Object} additionalData - Additional fixture data
 * @returns {Object} Created or existing fixture
 */
async function createOrUpdateFixture(team1, team2, additionalData = {}) {
  // First check if fixture already exists
  let fixture = await findExistingFixture(team1, team2);

  if (fixture) {
    // Update existing fixture if needed
    let updated = false;
    Object.keys(additionalData).forEach(key => {
      if (additionalData[key] !== undefined && fixture[key] !== additionalData[key]) {
        fixture[key] = additionalData[key];
        updated = true;
      }
    });

    if (updated) {
      await fixture.save();
      console.log(`📝 Updated existing fixture: ${fixture.team1} vs ${fixture.team2}`);
    }

    return fixture;
  }

  // Create new fixture if none exists
  fixture = new Fixture({
    team1,
    team2,
    ...additionalData
  });

  await fixture.save();
  console.log(`✨ Created new fixture: ${team1} vs ${team2}`);
  return fixture;
}

/**
 * Smart match result lookup that finds match results regardless of team order
 * @param {string} team1 - First team name
 * @param {string} team2 - Second team name
 * @returns {Object|null} Found match result or null
 */
async function findExistingMatchResult(team1, team2) {
  // Try to find match result with either team order
  const matchResult = await MatchResult.findOne({
    $or: [
      { team1: team1, team2: team2 },
      { team1: team2, team2: team1 }
    ]
  });

  if (matchResult) {
    console.log(`🔍 Found existing match result: ${matchResult.team1} vs ${matchResult.team2} (${matchResult.matchTitle})`);
    return matchResult;
  }

  return null;
}

/**
 * Smart match result creation that prevents duplicates
 * @param {Object} matchData - Match result data
 * @returns {Object} Created or existing match result
 */
async function createOrUpdateMatchResult(matchData) {
  const { team1, team2, matchNumber } = matchData;

  // First check if match result already exists by team combination
  let existingMatchResult = await findExistingMatchResult(team1, team2);

  if (existingMatchResult) {
    console.log(`📝 Found existing match result for these teams: ${existingMatchResult.team1} vs ${existingMatchResult.team2}`);
    console.log(`⚠️  Cannot create duplicate match result. Consider updating the existing one (ID: ${existingMatchResult._id})`);
    throw new Error(`Match result already exists for ${team1} vs ${team2}. Match: "${existingMatchResult.matchTitle}"`);
  }

  // Check for match number uniqueness
  const existingByNumber = await MatchResult.findOne({ matchNumber });
  if (existingByNumber) {
    throw new Error(`Match number ${matchNumber} already exists`);
  }

  // Create new match result
  const matchResult = new MatchResult(matchData);
  await matchResult.save();
  
  console.log(`✨ Created new match result: ${team1} vs ${team2} (${matchData.matchTitle})`);
  return matchResult;
}

/**
 * Update match result with team name consistency
 * @param {string} matchResultId - Match result ID to update
 * @param {Object} updateData - Data to update
 * @returns {Object} Updated match result
 */
async function updateMatchResultConsistently(matchResultId, updateData) {
  const matchResult = await MatchResult.findById(matchResultId);
  
  if (!matchResult) {
    throw new Error('Match result not found');
  }

  console.log(`📝 Updating match result: ${matchResult.team1} vs ${matchResult.team2}`);

  // If team names are being updated, ensure they match the current User records
  if (updateData.team1 || updateData.team2) {
    const User = require('../models/User');
    
    if (updateData.team1) {
      const team1User = await User.findOne({ teamName: updateData.team1, isActive: true });
      if (!team1User) {
        console.warn(`⚠️  Team "${updateData.team1}" not found in active users`);
      }
    }
    
    if (updateData.team2) {
      const team2User = await User.findOne({ teamName: updateData.team2, isActive: true });
      if (!team2User) {
        console.warn(`⚠️  Team "${updateData.team2}" not found in active users`);
      }
    }
  }

  // Update all provided fields
  Object.keys(updateData).forEach(key => {
    if (updateData[key] !== undefined) {
      matchResult[key] = updateData[key];
    }
  });

  matchResult.updatedAt = new Date();
  await matchResult.save();

  console.log(`✅ Updated match result: ${matchResult.team1} vs ${matchResult.team2}`);
  return matchResult;
}

module.exports = {
  updateTeamNameEverywhere,
  findExistingFixture,
  createOrUpdateFixture,
  findExistingMatchResult,
  createOrUpdateMatchResult,
  updateMatchResultConsistently
};
