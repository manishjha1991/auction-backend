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

    // Check if the user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isAdmin = user.isAdmin;

    // Fetch all players
    const allPlayers = await Player.find({}, '_id name type role basePrice style overallScore profilePicture isSold isActive');

    // Filter for active players
    const activePlayers = allPlayers.filter((player) => player.isActive);

    let playersToSend = [];
    if (isAdmin) {
      // Admin sees all active players
      playersToSend = activePlayers;
    } else {
      // User sees only their associated sold players
      const userPlayerAssociations = await UserPlayer.find({ userId, isActive: true }, 'playerId');
      const userPlayerIds = userPlayerAssociations.map((association) => association.playerId.toString());

      playersToSend = activePlayers.filter((player) =>
        player.isSold && userPlayerIds.includes(player._id.toString())
      );
    }

    // Fetch match performance stats for players
    const playersWithDetails = await Promise.all(
      playersToSend.map(async (player) => {
        // Fetch match stats
        const stats = await PlayerStats.find({ playerId: player._id });

        // Calculate batting and bowling performance per match
        const battingStats = stats.map((stat) => ({
          match: stat.matchName,
          runs: stat.battingStats?.runs || 0,
          balls: stat.battingStats?.ballsFaced || 0,
          mom: stat.isManOfTheMatch || false,
          against: stat.opponent || 'Unknown',
        }));

        const bowlingStats = stats.map((stat) => ({
          match: stat.matchName,
          overs: Math.floor((stat.bowlingStats?.ballsBowled || 0) / 6),
          wickets: stat.bowlingStats?.wickets || 0,
          runs: stat.bowlingStats?.runsConceded || 0,
          mom: stat.isManOfTheMatch || false,
          against: stat.opponent || 'Unknown',
        }));

        // Calculate total stats
        const totalBattingRuns = battingStats.reduce((sum, match) => sum + match.runs, 0);
        const totalWickets = bowlingStats.reduce((sum, match) => sum + match.wickets, 0);

        return {
          name: player.name,
          matchPerformance: {
            batting: battingStats,
            bowling: bowlingStats,
          },
          totalStats: {
            batting: { runs: totalBattingRuns },
            bowling: { wickets: totalWickets },
          },
        };
      })
    );

    res.json({ players: playersWithDetails });
  } catch (error) {
    console.error('Error fetching player list:', error);
    res.status(500).json({ message: 'Error fetching player list', error });
  }
});


// Store player stats
router.post('/store', async (req, res) => {
  const { playerId, userId, opponentUserId, battingStats, bowlingStats, isMom } = req.body;

  try {
    const newStats = new PlayerStats({
      playerId,
      userId,
      opponentUserId,
      battingStats,
      bowlingStats,
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



