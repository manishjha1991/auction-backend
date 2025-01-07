const express = require('express');
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const teams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
    })
      .populate('boughtPlayers')
      .select('_id teamName teamImage boughtPlayers');

    // Fetch all existing fixtures
    const existingFixtures = await Fixture.find();
    const uniqueFixtureMap = new Set();

    // Deduplicate existing fixtures but retain those with a winner
    for (const fixture of existingFixtures) {
      const sortedKey = [fixture.team1, fixture.team2].sort().join('-');
      if (uniqueFixtureMap.has(sortedKey)) {
        if (!fixture.winner) {
          // Delete fixture only if the winner field is null
          await Fixture.deleteOne({ _id: fixture._id });
        }
      } else {
        uniqueFixtureMap.add(sortedKey);
      }
    }

    // Re-fetch the cleaned fixtures
    const cleanedFixtures = await Fixture.find();

    const teamNames = teams.map((team) => team.teamName);
    const fixtureMap = new Set(
      cleanedFixtures.map((f) => [f.team1, f.team2].sort().join('-'))
    );
    const newFixtures = [];

    // Generate new fixtures while avoiding duplicates
    for (let i = 0; i < teamNames.length; i++) {
      for (let j = i + 1; j < teamNames.length; j++) {
        const team1 = teamNames[i];
        const team2 = teamNames[j];
        const fixtureKey = [team1, team2].sort().join('-');

        if (!fixtureMap.has(fixtureKey)) {
          newFixtures.push({ team1, team2 });
          fixtureMap.add(fixtureKey);
        }
      }
    }

    if (newFixtures.length > 0) {
      await Fixture.insertMany(newFixtures);
    }

    const allFixtures = await Fixture.find().sort({ createdAt: 1 });

    // Enhance fixtures with team details
    const enhancedFixtures = allFixtures.map((fixture) => {
      const team1Details = teams.find((team) => team.teamName === fixture.team1) || {};
      const team2Details = teams.find((team) => team.teamName === fixture.team2) || {};

      return {
        ...fixture._doc,
        team1Details: {
          teamName: team1Details.teamName || 'Unknown',
          teamImage: team1Details.teamImage || null,
          players: team1Details.boughtPlayers || [],
        },
        team2Details: {
          teamName: team2Details.teamName || 'Unknown',
          teamImage: team2Details.teamImage || null,
          players: team2Details.boughtPlayers || [],
        },
      };
    });

    res.status(200).json(enhancedFixtures);
  } catch (error) {
    console.error('Error fetching fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch fixtures.' });
  }
});





router.post('/save', async (req, res) => {
  try {
    const { team1, team2, winner, margin, mom, team1Score, team2Score } = req.body;

    let fixture = await Fixture.findOne({ team1, team2 });

    if (!fixture) {
      fixture = new Fixture({ team1, team2, winner, margin, mom, team1Score, team2Score });
    } else {
      fixture.winner = winner;
      fixture.margin = margin;
      fixture.mom = mom;
      fixture.team1Score = team1Score;
      fixture.team2Score = team2Score;
    }

    await fixture.save();
    res.status(200).json({ message: 'Fixture result saved successfully!', fixture });
  } catch (error) {
    console.error('Error saving fixture:', error);
    res.status(500).json({ message: 'Failed to save fixture result.' });
  }
});

  
module.exports = router;
  

