const express = require('express');
const router = express.Router();
const PlayoffFixture = require('../models/PlayoffFixture');
const User = require('../models/User');

// Get all playoff fixtures
router.get('/', async (req, res) => {
  try {
    const playoffFixtures = await PlayoffFixture.find().sort({ matchId: 1 });
    console.log('Fetching playoff fixtures:', playoffFixtures.map(f => `${f.matchId}: ${f.team1} vs ${f.team2}`));
    res.json(playoffFixtures);
  } catch (error) {
    console.error('Error fetching playoff fixtures:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Initialize playoff fixtures - different logic based on mode
router.post('/initialize', async (req, res) => {
  try {
    const { mode } = req.body; // Get mode from request body
    console.log('Playoff initialization mode:', mode); // Debug log

    if (mode === 'groups') {
      // GROUPS MODE: Top 3 from each group
      // Use same filters as point table: teamName exists, not NA, isActive, not admin
      // Note: isTournamentReady filter removed to match point table logic
      const groupARaw = await User.find({ 
        teamName: { $exists: true, $ne: null, $ne: "NA" },
        group: 'A',
        isAdmin: false,
        isActive: true
      })
        .select('_id teamName points matchesPlayed fairnessPoint')
        .lean();
      
      // Sort exactly like point table: points desc, fairness desc, matchesPlayed asc, teamName asc
      const groupATeams = groupARaw.sort((a, b) => {
        const pointsA = a.points || 0;
        const pointsB = b.points || 0;
        if (pointsB !== pointsA) return pointsB - pointsA;
        
        const fairnessA = a.fairnessPoint || 0;
        const fairnessB = b.fairnessPoint || 0;
        if (fairnessB !== fairnessA) return fairnessB - fairnessA;
        
        const matchesA = a.matchesPlayed || 0;
        const matchesB = b.matchesPlayed || 0;
        if (matchesA !== matchesB) return matchesA - matchesB;
        
        const nameA = (a.teamName || '').toLowerCase();
        const nameB = (b.teamName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      }).slice(0, 3);

      const groupBRaw = await User.find({ 
        teamName: { $exists: true, $ne: null, $ne: "NA" },
        group: 'B',
        isAdmin: false,
        isActive: true
      })
        .select('_id teamName points matchesPlayed fairnessPoint')
        .lean();
      
      // Sort exactly like point table: points desc, fairness desc, matchesPlayed asc, teamName asc
      const groupBTeams = groupBRaw.sort((a, b) => {
        const pointsA = a.points || 0;
        const pointsB = b.points || 0;
        if (pointsB !== pointsA) return pointsB - pointsA;
        
        const fairnessA = a.fairnessPoint || 0;
        const fairnessB = b.fairnessPoint || 0;
        if (fairnessB !== fairnessA) return fairnessB - fairnessA;
        
        const matchesA = a.matchesPlayed || 0;
        const matchesB = b.matchesPlayed || 0;
        if (matchesA !== matchesB) return matchesA - matchesB;
        
        const nameA = (a.teamName || '').toLowerCase();
        const nameB = (b.teamName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      }).slice(0, 3);

      if (groupATeams.length < 3 || groupBTeams.length < 3) {
        return res.status(400).json({ 
          message: 'Need at least 3 teams in each group to initialize playoffs',
          groupA: groupATeams.length,
          groupB: groupBTeams.length
        });
      }

      // Check if all qualifying teams have completed 6 matches
      const allQualifyingTeams = [...groupATeams, ...groupBTeams];
      const allTeamsCompleted6Games = allQualifyingTeams.every(team => (team.matchesPlayed || 0) >= 6);
      
      if (!allTeamsCompleted6Games) {
        const incompleteTeams = allQualifyingTeams.filter(team => (team.matchesPlayed || 0) < 6);
        return res.status(400).json({ 
          message: 'All qualifying teams must complete 6 matches before initializing playoffs',
          incompleteTeams: incompleteTeams.map(team => ({
            teamName: team.teamName,
            group: team.group,
            matchesPlayed: team.matchesPlayed || 0
          }))
        });
      }

      // Group A: A1, A2, A3 (top 3)
      const [A1, A2, A3] = groupATeams;
      // Group B: B1, B2, B3 (top 3)
      const [B1, B2, B3] = groupBTeams;
      
      console.log('Group A teams:', groupATeams.map(t => ({ name: t.teamName, points: t.points, group: t.group })));
      console.log('Group B teams:', groupBTeams.map(t => ({ name: t.teamName, points: t.points, group: t.group })));

      // Clear existing playoff fixtures
      await PlayoffFixture.deleteMany({});

      // Create playoff fixtures according to new groups format
      const playoffFixtures = [
        {
          matchId: 'Q1',
          stage: 'QUALIFIER 1',
          team1: A2.teamName, // A2
          team2: B3.teamName, // B3
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'A2 vs B3'
        },
        {
          matchId: 'Q2',
          stage: 'QUALIFIER 2',
          team1: B2.teamName, // B2
          team2: A3.teamName, // A3
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'B2 vs A3'
        },
        {
          matchId: 'SF1',
          stage: 'SEMI-FINAL 1',
          team1: A1.teamName, // A1
          team2: 'Winner of Qualifier 1',
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'A1 vs Winner of Q1'
        },
        {
          matchId: 'SF2',
          stage: 'SEMI-FINAL 2',
          team1: B1.teamName, // B1
          team2: 'Winner of Qualifier 2',
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'B1 vs Winner of Q2'
        },
        {
          matchId: 'F',
          stage: 'FINAL',
          team1: 'Winner of Semi-Final 1',
          team2: 'Winner of Semi-Final 2',
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'Winner of SF1 vs Winner of SF2'
        }
      ];

      await PlayoffFixture.insertMany(playoffFixtures);
      console.log('Created playoff fixtures:', playoffFixtures.map(f => `${f.matchId}: ${f.team1} vs ${f.team2}`));
      
      res.json({ 
        message: 'Playoff fixtures initialized successfully (Groups Mode)',
        format: 'Top 3 from each group qualify',
        fixtures: playoffFixtures.length
      });

    } else {
      // NORMAL MODE: Original format with top 6 overall teams
      // Use same filters and sorting as point table endpoint
      // Filter: teamName exists, not NA, isActive, not admin
      // Sort: points desc, fairness desc, matchesPlayed asc, teamName asc
      const allTeams = await User.find({ 
        teamName: { $exists: true, $ne: null, $ne: "NA" },
        isAdmin: false,
        isActive: true
      })
        .select('_id teamName points matchesPlayed fairnessPoint')
        .lean();
      
      // Sort exactly like point table
      const teams = allTeams.sort((a, b) => {
        const pointsA = a.points || 0;
        const pointsB = b.points || 0;
        if (pointsB !== pointsA) return pointsB - pointsA;
        
        const fairnessA = a.fairnessPoint || 0;
        const fairnessB = b.fairnessPoint || 0;
        if (fairnessB !== fairnessA) return fairnessB - fairnessA;
        
        const matchesA = a.matchesPlayed || 0;
        const matchesB = b.matchesPlayed || 0;
        if (matchesA !== matchesB) return matchesA - matchesB;
        
        const nameA = (a.teamName || '').toLowerCase();
        const nameB = (b.teamName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      }).slice(0, 6);

      if (teams.length < 6) {
        return res.status(400).json({ message: 'Need at least 6 teams to initialize playoffs' });
      }

      // Check if all top 6 teams have completed required games
      const allTeamsCompletedGames = teams.every(team => (team.matchesPlayed || 0) >= 12);
      
      if (!allTeamsCompletedGames) {
        const incompleteTeams = teams.filter(team => (team.matchesPlayed || 0) < 12);
        return res.status(400).json({ 
          message: 'All top 6 teams must complete 12 matches before initializing playoffs',
          incompleteTeams: incompleteTeams.map(team => ({
            teamName: team.teamName,
            matchesPlayed: team.matchesPlayed || 0
          }))
        });
      }

      const [team1, team2, team3, team4, team5, team6] = teams;

      // Clear existing playoff fixtures
      await PlayoffFixture.deleteMany({});

      // Create playoff fixtures according to original format
      const playoffFixtures = [
        {
          matchId: 'A',
          stage: 'ELIMINATOR ROUND',
          team1: team3.teamName,
          team2: team6.teamName,
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'B',
          stage: 'ELIMINATOR ROUND',
          team1: team4.teamName,
          team2: team5.teamName,
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'C',
          stage: 'QUALIFIER 1',
          team1: team1.teamName,
          team2: team2.teamName,
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'D',
          stage: 'ELIMINATOR 2',
          team1: 'Winner of Match A',
          team2: 'Winner of Match B',
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'E',
          stage: 'QUALIFIER 2',
          team1: 'Loser of Match C',
          team2: 'Winner of Match D',
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'F',
          stage: 'FINALS',
          team1: 'Winner of Match C',
          team2: 'Winner of Match E',
          team1Score: 'TBD',
          team2Score: 'TBD'
        }
      ];

      await PlayoffFixture.insertMany(playoffFixtures);
      res.json({ 
        message: 'Playoff fixtures initialized successfully (Normal Mode)',
        format: 'Top 6 overall teams qualify',
        fixtures: playoffFixtures.length
      });
    }
  } catch (error) {
    console.error('Error initializing playoff fixtures:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update playoff fixture
router.post('/update/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const updateData = req.body;

    console.log(`Updating playoff fixture ${matchId} with data:`, updateData);
    const playoffFixture = await PlayoffFixture.findOneAndUpdate(
      { matchId },
      updateData,
      { new: true }
    );
    console.log(`Updated playoff fixture:`, playoffFixture);

    if (!playoffFixture) {
      return res.status(404).json({ message: 'Playoff fixture not found' });
    }

    // If this match has a winner, update dependent matches
    console.log(`Match ${matchId} update data:`, { winner: updateData.winner, isCompleted: updateData.isCompleted });
    console.log(`Winner check: ${!!updateData.winner}, isCompleted check: ${!!updateData.isCompleted}`);
    
    if (updateData.winner && updateData.isCompleted) {
      console.log(`✅ Updating dependent matches for ${matchId} with winner: ${updateData.winner}`);
      await updateDependentMatches(matchId, updateData.winner);
      
      // Log the updated dependent matches
      const updatedFixtures = await PlayoffFixture.find({}).sort({ matchId: 1 });
      console.log('All playoff fixtures after update:', updatedFixtures.map(f => `${f.matchId}: ${f.team1} vs ${f.team2}`));
    } else {
      console.log(`❌ Not updating dependent matches - winner: ${updateData.winner}, isCompleted: ${updateData.isCompleted}`);
      console.log(`❌ Winner exists: ${!!updateData.winner}, isCompleted: ${!!updateData.isCompleted}`);
    }

    res.json(playoffFixture);
  } catch (error) {
    console.error('Error updating playoff fixture:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper function to update dependent matches
async function updateDependentMatches(matchId, winner) {
  try {
    // Check if this is groups mode or normal mode based on matchId
    // Groups mode uses: Q1, Q2, SF1, SF2, F (with stage "FINAL")
    // Normal mode uses: A, B, C, D, E, F (with stage "FINALS")
    let isGroupsMode = ['Q1', 'Q2', 'SF1', 'SF2'].includes(matchId);
    
    // For 'F' matchId, check the stage to distinguish between modes
    if (matchId === 'F') {
      const finalMatch = await PlayoffFixture.findOne({ matchId: 'F' });
      isGroupsMode = finalMatch && finalMatch.stage === 'FINAL';
    }
    
    console.log(`Mode detection for ${matchId}: isGroupsMode = ${isGroupsMode}`);
    
    console.log(`Updating dependent matches for ${matchId}, groups mode: ${isGroupsMode}`);
    
    if (isGroupsMode) {
      // GROUPS MODE: New format
      switch (matchId) {
        case 'Q1':
          // Update Semi-Final 1 team2 (Winner of Qualifier 1)
          console.log(`Updating SF1 team2 to: ${winner}`);
          const sf1Update = await PlayoffFixture.findOneAndUpdate(
            { matchId: 'SF1' },
            { team2: winner },
            { new: true }
          );
          console.log(`SF1 update result:`, sf1Update);
          break;
        case 'Q2':
          // Update Semi-Final 2 team2 (Winner of Qualifier 2)
          console.log(`Updating SF2 team2 to: ${winner}`);
          const sf2Update = await PlayoffFixture.findOneAndUpdate(
            { matchId: 'SF2' },
            { team2: winner },
            { new: true }
          );
          console.log(`SF2 update result:`, sf2Update);
          break;
        case 'SF1':
          // Update Final team1 (Winner of Semi-Final 1)
          console.log(`Updating F team1 to: ${winner}`);
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team1: winner }
          );
          break;
        case 'SF2':
          // Update Final team2 (Winner of Semi-Final 2)
          console.log(`Updating F team2 to: ${winner}`);
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team2: winner }
          );
          break;
      }
    } else {
      // NORMAL MODE: Original format
      switch (matchId) {
        case 'A':
          // Update Match D team1
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'D' },
            { team1: winner }
          );
          break;
        case 'B':
          // Update Match D team2
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'D' },
            { team2: winner }
          );
          break;
        case 'C':
          // Update Match E team1 (loser) and Match F team1 (winner)
          const matchC = await PlayoffFixture.findOne({ matchId: 'C' });
          const loser = matchC.team1 === winner ? matchC.team2 : matchC.team1;
          
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'E' },
            { team1: loser }
          );
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team1: winner }
          );
          break;
        case 'D':
          // Update Match E team2
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'E' },
            { team2: winner }
          );
          break;
        case 'E':
          // Update Match F team2
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team2: winner }
          );
          break;
      }
    }
  } catch (error) {
    console.error('Error updating dependent matches:', error);
    console.error('Error details:', error.message, error.stack);
  }
}

// Test endpoint to manually trigger dependent match updates
router.post('/test-update/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { winner } = req.body;
    
    console.log(`Testing updateDependentMatches for ${matchId} with winner: ${winner}`);
    
    // Call the updateDependentMatches function directly
    await updateDependentMatches(matchId, winner);
    
    // Fetch and return all playoff fixtures
    const playoffFixtures = await PlayoffFixture.find().sort({ matchId: 1 });
    console.log('Playoff fixtures after test update:', playoffFixtures.map(f => `${f.matchId}: ${f.team1} vs ${f.team2}`));
    
    res.json({ 
      message: `Test update completed for ${matchId}`,
      fixtures: playoffFixtures 
    });
  } catch (error) {
    console.error('Error in test update:', error);
    res.status(500).json({ message: 'Test update failed', error: error.message });
  }
});

module.exports = router;
