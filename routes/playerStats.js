const express = require('express');
const router = express.Router();
const PlayerStats = require('../models/PlayerStats'); // Adjust the path as needed
const Player = require('../models/Player'); // Adjust the path
const User = require('../models/User'); // Adjust the path
const UserPlayer = require('../models/UserPlayer'); // Adjust the path
// Load list of players with playerId and userId

router.get('/list', async (req, res) => {
  try {
    const { userId } = req.query;

    // Check if the user exists and populate the boughtPlayers field
    const user = await User.findById(userId).populate({
      path: 'boughtPlayers',
      match: { isSold: true, isActive: true },
      select:
        '_id name type role basePrice style overallScore profilePicture isSold isActive'
    });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isAdmin = user.isAdmin;
    let playersToSend = [];

    if (isAdmin) {
      // Admin sees all active sold players from the Player collection
      playersToSend = await Player.find(
        { isSold: true, isActive: true },
        '_id name type role basePrice style overallScore profilePicture isSold isActive'
      );
    } else {
      // Normal user sees only the players they have bought
      playersToSend = user.boughtPlayers || [];
    }

    // Helper function to convert balls into overs (X.Y format)
    const convertBallsToOvers = (balls) => {
      const b = balls || 0;
      const overs = Math.floor(b / 6);
      const remainder = b % 6;
      return `${overs}.${remainder}`;
    };

    // Fetch match performance stats for each player
    const playersWithDetails = await Promise.all(
      playersToSend.map(async (player) => {
        // Fetch match stats for this player
        const stats = await PlayerStats.find({ playerId: player._id });
        
        // Calculate batting performance per match
        const battingStats = await Promise.all(
          stats.map(async (stat) => ({
            match: stat.matchName,
            runs: stat.battingStats?.runs || 0,
            balls: stat.battingStats?.balls || 0,
            mom: stat.isMom || false,
            // Lookup the opponent's team name from the User model
            against:
              (await User.findById(stat.opponentUserId).select('teamName'))
                ?.teamName || 'Unknown'
          }))
        );

        // Calculate bowling performance per match
        const bowlingStats = await Promise.all(
          stats.map(async (stat) => ({
            match: stat.matchName,
            overs: convertBallsToOvers(stat.bowlingStats?.ballsBowled),
            wickets: stat.bowlingStats?.wickets || 0,
            runs: stat.bowlingStats?.runsGiven || 0,
            mom: stat.isMom || false,
            // Lookup the opponent's team name from the User model
            against:
              (await User.findById(stat.opponentUserId).select('teamName'))
                ?.teamName || 'Unknown'
          }))
        );

        // Calculate total stats
        const totalBattingRuns = battingStats.reduce(
          (sum, match) => sum + match.runs,
          0
        );
        const totalWickets = bowlingStats.reduce(
          (sum, match) => sum + match.wickets,
          0
        );

        return {
          _id: player._id,
          name: player.name,
          type: player.type,
          role: player.role,
          team: user.teamName, // Get team name from the user document
          matchPerformance: {
            batting: battingStats,
            bowling: bowlingStats
          },
          totalStats: {
            batting: { runs: totalBattingRuns },
            bowling: { wickets: totalWickets }
          }
        };
      })
    );

    // ---------------------------
    // Create Playoff Fixtures
    // ---------------------------
    // For this example, we are simply querying the top five teams (active teams with a valid teamName).
    // Adjust the sorting field based on your ranking system.
    const playoffTeams = await User.find({
      isActive: true,
      teamName: { $exists: true, $ne: null, $ne: 'NA' }
    })
      .sort({ teamName: 1 }) // Replace with your ranking criteria if available
      .limit(5);
    
    let playoffFixtures = [];
    if (playoffTeams.length === 5) {
      playoffFixtures = [
        {
          matchType: 'Qualifier 1',
          team1: playoffTeams[0].teamName,
          team2: playoffTeams[1].teamName,
          // In Qualifier 1, the winner advances directly to the Final,
          // and the loser goes to Qualifier 2.
        },
        {
          matchType: 'Eliminator 1',
          team1: playoffTeams[2].teamName,
          team2: playoffTeams[3].teamName,
          // The winner of Eliminator 1 goes to Qualifier 2.
        },
        {
          matchType: 'Qualifier 2',
          team1: 'TBD (Loser of Qualifier 1)',
          team2: 'TBD (Winner of Eliminator 1)',
          // Winner advances; loser plays in Eliminator 3.
        },
        {
          matchType: 'Eliminator 3',
          team1: 'TBD (Loser of Qualifier 2)',
          team2: playoffTeams[4].teamName,
          // The winner advances to the Final.
        },
        {
          matchType: 'Final',
          team1: 'TBD (Winner Qualifier 1)',
          team2: 'TBD (Winner of Eliminator 3)',
          // The champion is decided in the Final.
        }
      ];
    }
    // ---------------------------

    res.json({ players: playersWithDetails, playoffFixtures });
  } catch (error) {
    console.error('Error fetching player list:', error);
    res.status(500).json({ message: 'Error fetching player list', error });
  }
});





// Store player stats
router.post('/store', async (req, res) => {
  // Destructure the extra field "wicketsTaken" along with the others.
  const { playerId, userId, opponentUserId, battingStats, bowlingStats, wicketsTaken, isMom } = req.body;

  try {
    const newStats = new PlayerStats({
      playerId,
      userId,
      opponentUserId,
      battingStats,
      bowlingStats: {
        runsGiven: bowlingStats.runsGiven,
        ballsBowled: bowlingStats.ballsBowled,
        wickets: wicketsTaken   // <-- store the extra field value here
      },
      isMom: isMom || false, // Default to false if not provided
    });
    await newStats.save();

    res.status(201).json({ message: 'Player stats saved successfully', data: newStats });
  } catch (error) {
    res.status(500).json({ message: 'Error saving player stats', error });
  }
});



// Fetch stats for a player


router.get('/stats/:playerId', async (req, res) => {
  const { playerId } = req.params;

  try {
    // Fetch stats for the given playerId
    const stats = await PlayerStats.find({ playerId })
      .populate('userId', 'name') // Populate user details
      .populate('opponentUserId', 'name'); // Populate opponent details

    // Calculate total stats
    let totalRuns = 0;
    let totalWickets = 0;

    stats.forEach(stat => {
      if (stat.battingStats?.runs) {
        totalRuns += stat.battingStats.runs;
      }
      if (stat.bowlingStats?.ballsBowled && stat.bowlingStats?.runsGiven) {
        totalWickets += Math.floor(stat.bowlingStats.ballsBowled / 6); // Example logic for wickets
      }
    });

    const response = {
      stats: stats.map(stat => ({
        id: stat._id,
        playerId: stat.playerId,
        user: stat.userId?.name || null,
        opponent: stat.opponentUserId?.name || null,
        battingStats: stat.battingStats,
        bowlingStats: stat.bowlingStats,
        isMom: stat.isMom,
        createdAt: stat.createdAt,
      })),
      totalStats: {
        totalScore: totalRuns,
        totalWickets,
      },
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching player stats:', error);
    res.status(500).json({ message: 'Error fetching player stats', error });
  }
});



module.exports = router;



