const express = require('express');
const router = express.Router();
const PlayoffFixture = require('../models/PlayoffFixture');
const User = require('../models/User');

// Get all playoff fixtures
router.get('/', async (req, res) => {
  try {
    const playoffFixtures = await PlayoffFixture.find().sort({ matchId: 1 });
    res.json(playoffFixtures);
  } catch (error) {
    console.error('Error fetching playoff fixtures:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Initialize playoff fixtures with top 6 teams
router.post('/initialize', async (req, res) => {
  try {
    // Get top 6 teams from points table
    const teams = await User.find({ teamName: { $ne: "NA" } })
      .sort({ points: -1, fairness: -1 })
      .limit(6);

    if (teams.length < 6) {
      return res.status(400).json({ message: 'Need at least 6 teams to initialize playoffs' });
    }

    const [team1, team2, team3, team4, team5, team6] = teams;

    // Clear existing playoff fixtures
    await PlayoffFixture.deleteMany({});

    // Create playoff fixtures
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
    res.json({ message: 'Playoff fixtures initialized successfully' });
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

    const playoffFixture = await PlayoffFixture.findOneAndUpdate(
      { matchId },
      updateData,
      { new: true }
    );

    if (!playoffFixture) {
      return res.status(404).json({ message: 'Playoff fixture not found' });
    }

    // If this match has a winner, update dependent matches
    if (updateData.winner && updateData.isCompleted) {
      await updateDependentMatches(matchId, updateData.winner);
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
  } catch (error) {
    console.error('Error updating dependent matches:', error);
  }
}

module.exports = router;
