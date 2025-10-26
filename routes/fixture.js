const express = require('express');
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');

const router = express.Router();



router.get('/', async (req, res) => {
  try {
    // Get mode from query parameter
    const mode = req.query.mode || 'normal';
    console.log(`🏏 Fixture generation mode: ${mode}`);
    
    // 1) Fetch teams (users) that have a valid teamName, are active, tournament ready, and are not admin.
    const teams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isTournamentReady: true, // Only include users who are tournament ready
      isAdmin: { $ne: true } // Exclude admin teams
    })
      .populate('boughtPlayers')
      .select('teamName teamImage boughtPlayers group'); 
      // Notice we DO NOT select _id, 
      // because we only match on teamName now

    // 2) Fetch all active fixtures (which store team1/team2 as strings)
    const existingFixtures = await Fixture.find({ isActive: true });

    // Advanced deduplication of existing fixtures with the same pair of team names
    const fixtureMap = new Map();
    const duplicatesToDelete = [];
    
    for (const fixture of existingFixtures) {
      const sortedKey = [fixture.team1, fixture.team2].sort().join('-');
      
      if (fixtureMap.has(sortedKey)) {
        const existingFixture = fixtureMap.get(sortedKey);
        
        // Keep the fixture with a winner, or the newer one if both have/don't have winners
        if (existingFixture.winner && !fixture.winner) {
          // Keep existing (has winner), delete current (no winner)
          duplicatesToDelete.push(fixture._id);
        } else if (!existingFixture.winner && fixture.winner) {
          // Delete existing (no winner), keep current (has winner)
          duplicatesToDelete.push(existingFixture._id);
          fixtureMap.set(sortedKey, fixture);
        } else if (!existingFixture.winner && !fixture.winner) {
          // Neither has winner, keep the newer one
          if (fixture.createdAt > existingFixture.createdAt) {
            duplicatesToDelete.push(existingFixture._id);
            fixtureMap.set(sortedKey, fixture);
          } else {
            duplicatesToDelete.push(fixture._id);
          }
        } else {
          // Both have winners, keep the older one (first completed match)
          if (fixture.createdAt > existingFixture.createdAt) {
            duplicatesToDelete.push(fixture._id);
          } else {
            duplicatesToDelete.push(existingFixture._id);
            fixtureMap.set(sortedKey, fixture);
          }
        }
      } else {
        fixtureMap.set(sortedKey, fixture);
      }
    }
    
    // Delete all identified duplicates in one go
    if (duplicatesToDelete.length > 0) {
      await Fixture.deleteMany({ _id: { $in: duplicatesToDelete } });
      console.log(`🗑️ Deleted ${duplicatesToDelete.length} duplicate fixtures`);
    }

    // 3) Use the cleaned fixture map for existing fixture keys
    const existingFixtureKeys = new Set(fixtureMap.keys());

    // 4) Separate teams by groups
    const groupA = teams.filter(team => team.group === 'A');
    const groupB = teams.filter(team => team.group === 'B');
    const ungroupedTeams = teams.filter(team => !team.group || team.group === null);

    // 6) Generate new fixtures based on mode
    const newFixtures = [];

    if (mode === 'groups') {
      // GROUP STAGE: Generate fixtures within each group
      console.log('🏆 Generating GROUP STAGE fixtures...');
      
      // Group A fixtures
      if (groupA.length > 1) {
        for (let i = 0; i < groupA.length; i++) {
          for (let j = i + 1; j < groupA.length; j++) {
            const t1 = groupA[i].teamName;
            const t2 = groupA[j].teamName;
            const fixtureKey = [t1, t2].sort().join('-');

            if (!existingFixtureKeys.has(fixtureKey)) {
              newFixtures.push({ 
                team1: t1, 
                team2: t2, 
                group: 'A',
                matchType: 'group'
              });
              existingFixtureKeys.add(fixtureKey);
            }
          }
        }
      }

      // Group B fixtures
      if (groupB.length > 1) {
        for (let i = 0; i < groupB.length; i++) {
          for (let j = i + 1; j < groupB.length; j++) {
            const t1 = groupB[i].teamName;
            const t2 = groupB[j].teamName;
            const fixtureKey = [t1, t2].sort().join('-');

            if (!existingFixtureKeys.has(fixtureKey)) {
              newFixtures.push({ 
                team1: t1, 
                team2: t2, 
                group: 'B',
                matchType: 'group'
              });
              existingFixtureKeys.add(fixtureKey);
            }
          }
        }
      }

      // If there are ungrouped teams, create normal fixtures for them
      if (ungroupedTeams.length > 1) {
        for (let i = 0; i < ungroupedTeams.length; i++) {
          for (let j = i + 1; j < ungroupedTeams.length; j++) {
            const t1 = ungroupedTeams[i].teamName;
            const t2 = ungroupedTeams[j].teamName;
            const fixtureKey = [t1, t2].sort().join('-');

            if (!existingFixtureKeys.has(fixtureKey)) {
              newFixtures.push({ 
                team1: t1, 
                team2: t2, 
                group: null,
                matchType: 'normal'
              });
              existingFixtureKeys.add(fixtureKey);
            }
          }
        }
      }
    } else {
      // NORMAL MODE: Generate fixtures for all teams (everyone plays everyone)
      console.log('🏏 Generating NORMAL fixtures...');
      console.log(`📊 Found ${teams.length} teams for normal mode fixture generation`);
      const teamNames = teams.map((team) => team.teamName);
      
      // Calculate expected number of fixtures (n choose 2)
      const expectedFixtures = (teams.length * (teams.length - 1)) / 2;
      console.log(`📊 Expected fixtures for ${teams.length} teams: ${expectedFixtures} (every team plays each other once)`);
      
      // Generate fixtures for ALL teams regardless of group assignment
      for (let i = 0; i < teamNames.length; i++) {
        for (let j = i + 1; j < teamNames.length; j++) {
          const t1 = teamNames[i];
          const t2 = teamNames[j];
          const fixtureKey = [t1, t2].sort().join('-');

          if (!existingFixtureKeys.has(fixtureKey)) {
            newFixtures.push({ 
              team1: t1, 
              team2: t2, 
              group: null,
              matchType: 'normal'
            });
            existingFixtureKeys.add(fixtureKey);
          }
        }
      }
    }

    // 7) Create new fixtures using smart creation to prevent duplicates
    let insertedFixtures = [];
    if (newFixtures.length > 0) {
      const { createOrUpdateFixture } = require('../utils/teamNameUpdater');
      
      console.log(`🔨 Processing ${newFixtures.length} new fixtures with smart creation...`);
      for (const fixtureData of newFixtures) {
        try {
          const createdFixture = await createOrUpdateFixture(
            fixtureData.team1, 
            fixtureData.team2, 
            {
              group: fixtureData.group,
              matchType: fixtureData.matchType
            }
          );
          insertedFixtures.push(createdFixture);
          
          // Add to our fixture map
          const sortedKey = [createdFixture.team1, createdFixture.team2].sort().join('-');
          fixtureMap.set(sortedKey, createdFixture);
        } catch (error) {
          console.error(`❌ Error creating fixture ${fixtureData.team1} vs ${fixtureData.team2}:`, error.message);
        }
      }
      
      console.log(`✅ Smart fixture creation completed: ${insertedFixtures.length} fixtures processed`);
    }
    
    // 7.5) Log total fixture count
    const totalActiveFixtures = await Fixture.countDocuments({ isActive: true });
    console.log(`📊 Total active fixtures in database: ${totalActiveFixtures}`);

    // 8) Get all fixtures from our cleaned map and sort by createdAt
    const allFixtures = Array.from(fixtureMap.values()).sort((a, b) => 
      new Date(a.createdAt) - new Date(b.createdAt)
    );

    // 9) Enhance each fixture with user/team details, matched by teamName
    const enhancedFixtures = allFixtures.map((fixture) => {
      // Try to find user details by matching user.teamName === fixture.team1
      const team1Details = teams.find(
        (t) => t.teamName === fixture.team1
      ) || {};

      // Same for team2
      const team2Details = teams.find(
        (t) => t.teamName === fixture.team2
      ) || {};

      return {
        ...fixture._doc,
        // Keep the original team1/team2 in place 
        // or override them if you'd like, e.g.:
        // team1: team1Details.teamName || fixture.team1,
        // team2: team2Details.teamName || fixture.team2,
        team1: fixture.team1,
        team2: fixture.team2,

        // Add extra details
        team1Details: {
          teamName: team1Details.teamName || fixture.team1 || 'Unknown',
          teamImage: team1Details.teamImage || null,
          players: team1Details.boughtPlayers || [],
        },
        team2Details: {
          teamName: team2Details.teamName || fixture.team2 || 'Unknown',
          teamImage: team2Details.teamImage || null,
          players: team2Details.boughtPlayers || [],
        },
      };
    });

    // Return final list
    res.status(200).json(enhancedFixtures);
  } catch (error) {
    console.error('Error fetching fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch fixtures.' });
  }
});

router.post('/save', async (req, res) => {
  try {
    const {
      team1,
      team2,
      winner,
      margin,
      mom,
      team1Score,
      team2Score,
      team1Fairness,
      team2Fairness,
      group,
      matchType,
    } = req.body;

    // Use smart fixture lookup to find existing fixture regardless of team order
    const { findExistingFixture } = require('../utils/teamNameUpdater');
    let fixture = await findExistingFixture(team1, team2);

    // If no existing fixture, create a new one
    if (!fixture) {
      fixture = new Fixture({
        team1,
        team2,
        winner,
        margin,
        mom,
        team1Score,
        team2Score,
        team1Fairness,
        team2Fairness,
        group: group || null,
        matchType: matchType || 'normal',
      });
      console.log(`✨ Creating new fixture: ${team1} vs ${team2}`);
    } else {
      console.log(`📝 Updating existing fixture: ${fixture.team1} vs ${fixture.team2}`);
      
      // If teams are swapped in existing fixture, adjust the incoming data to match fixture order
      let adjustedTeam1 = team1, adjustedTeam2 = team2;
      let adjustedTeam1Score = team1Score, adjustedTeam2Score = team2Score;
      let adjustedTeam1Fairness = team1Fairness, adjustedTeam2Fairness = team2Fairness;
      let adjustedWinner = winner;

      if (fixture.team1 === team2 && fixture.team2 === team1) {
        // Teams are swapped - adjust all data to match existing fixture order
        adjustedTeam1 = team2;
        adjustedTeam2 = team1;
        adjustedTeam1Score = team2Score;
        adjustedTeam2Score = team1Score;
        adjustedTeam1Fairness = team2Fairness;
        adjustedTeam2Fairness = team1Fairness;
        
        // Adjust winner to match correct team position in fixture
        if (winner === team1) {
          adjustedWinner = fixture.team2; // team1 maps to fixture.team2
        } else if (winner === team2) {
          adjustedWinner = fixture.team1; // team2 maps to fixture.team1
        }
        
        console.log(`🔄 Teams swapped in existing fixture - adjusting data to match fixture order`);
      }

      // Update existing fixture with adjusted data
      fixture.winner = adjustedWinner;
      fixture.margin = margin;
      fixture.mom = mom;
      fixture.team1Score = adjustedTeam1Score;
      fixture.team2Score = adjustedTeam2Score;
      fixture.team1Fairness = adjustedTeam1Fairness;
      fixture.team2Fairness = adjustedTeam2Fairness;
      // Update group and matchType if provided
      if (group !== undefined) fixture.group = group;
      if (matchType !== undefined) fixture.matchType = matchType;
    }

    await fixture.save();
    
    // Automatically update points for both teams after fixture is saved
    if (fixture.winner) {
      try {
        // Find both teams by teamName
        const team1User = await User.findOne({ teamName: fixture.team1 });
        const team2User = await User.findOne({ teamName: fixture.team2 });
        
        if (team1User && team2User) {
          // Update team1: winner gets +2 points, loser gets +0 points
          if (fixture.winner === fixture.team1) {
            team1User.points = (team1User.points || 0) + 2;
            team2User.points = (team2User.points || 0) + 0;
          } else {
            team1User.points = (team1User.points || 0) + 0;
            team2User.points = (team2User.points || 0) + 2;
          }
          
          // Add fairness points to both teams
          team1User.fairnessPoint = (team1User.fairnessPoint || 0) + (fixture.team1Fairness || 0);
          team2User.fairnessPoint = (team2User.fairnessPoint || 0) + (fixture.team2Fairness || 0);
          
          // Increment matches played for both teams
          team1User.matchesPlayed = (team1User.matchesPlayed || 0) + 1;
          team2User.matchesPlayed = (team2User.matchesPlayed || 0) + 1;
          
          // Save both users
          await Promise.all([team1User.save(), team2User.save()]);
          
          console.log(`✅ Points updated: ${fixture.team1} (${fixture.winner === fixture.team1 ? 'WIN +2' : 'LOSS +0'}) vs ${fixture.team2} (${fixture.winner === fixture.team2 ? 'WIN +2' : 'LOSS +0'})`);
        }
      } catch (pointsError) {
        console.error('Error updating points:', pointsError);
        // Don't fail the fixture save if points update fails
      }
    }
    
    res.status(200).json({
      message: 'Fixture result saved successfully! Points updated automatically.',
      fixture,
    });
  } catch (error) {
    console.error('Error saving fixture:', error);
    res.status(500).json({ message: 'Failed to save fixture result.' });
  }
});

// Get fixtures filtered by group or match type
router.get('/filter', async (req, res) => {
  try {
    const { group, matchType } = req.query;
    
    let query = { isActive: true };
    
    if (group) {
      query.group = group;
    }
    
    if (matchType) {
      query.matchType = matchType;
    }
    
    const fixtures = await Fixture.find(query).sort({ createdAt: 1 });
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching filtered fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch filtered fixtures.' });
  }
});

// Get group stage fixtures only
router.get('/group-stage', async (req, res) => {
  try {
    const fixtures = await Fixture.find({ 
      isActive: true, 
      matchType: 'group' 
    }).sort({ createdAt: 1 });
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching group stage fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch group stage fixtures.' });
  }
});

// Get normal fixtures only
router.get('/normal', async (req, res) => {
  try {
    const fixtures = await Fixture.find({ 
      isActive: true, 
      matchType: 'normal' 
    }).sort({ createdAt: 1 });
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching normal fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch normal fixtures.' });
  }
});

// Admin route to manually clean up duplicate fixtures
router.post('/cleanup-duplicates', async (req, res) => {
  try {
    console.log('🧹 Starting manual fixture cleanup...');
    
    const existingFixtures = await Fixture.find({ isActive: true });
    const fixtureMap = new Map();
    const duplicatesToDelete = [];
    
    for (const fixture of existingFixtures) {
      const sortedKey = [fixture.team1, fixture.team2].sort().join('-');
      
      if (fixtureMap.has(sortedKey)) {
        const existingFixture = fixtureMap.get(sortedKey);
        
        // Keep the fixture with a winner, or the newer one if both have/don't have winners
        if (existingFixture.winner && !fixture.winner) {
          duplicatesToDelete.push(fixture._id);
        } else if (!existingFixture.winner && fixture.winner) {
          duplicatesToDelete.push(existingFixture._id);
          fixtureMap.set(sortedKey, fixture);
        } else if (!existingFixture.winner && !fixture.winner) {
          // Neither has winner, keep the newer one
          if (fixture.createdAt > existingFixture.createdAt) {
            duplicatesToDelete.push(existingFixture._id);
            fixtureMap.set(sortedKey, fixture);
          } else {
            duplicatesToDelete.push(fixture._id);
          }
        } else {
          // Both have winners, keep the older one (first completed match)
          if (fixture.createdAt > existingFixture.createdAt) {
            duplicatesToDelete.push(fixture._id);
          } else {
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
      await Fixture.deleteMany({ _id: { $in: duplicatesToDelete } });
      deletedCount = duplicatesToDelete.length;
      console.log(`🗑️ Deleted ${deletedCount} duplicate fixtures`);
    }
    
    res.status(200).json({
      message: `Fixture cleanup completed. Deleted ${deletedCount} duplicate fixtures.`,
      deletedCount,
      remainingFixtures: fixtureMap.size
    });
  } catch (error) {
    console.error('Error during fixture cleanup:', error);
    res.status(500).json({ message: 'Failed to cleanup fixtures.' });
  }
});

module.exports = router;

