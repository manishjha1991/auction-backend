const express = require('express');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');

const router = express.Router();

// Get all teams with their showcase data
router.get('/teams', async (req, res) => {
  try {
    const teams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isTournamentReady: true
    }).select('_id teamName teamImage captain teamColor teamBrief trophiesWon teamMotto group');

    res.json({
      success: true,
      teams: teams
    });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Get detailed team data with players
router.get('/teams/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    
    // Get team basic info
    const team = await User.findById(teamId).select('_id teamName teamImage captain viceCaptain teamColor teamBrief trophiesWon teamMotto group');
    
    if (!team) {
      return res.status(404).json({ success: false, error: 'Team not found' });
    }

    // Get team's players
    const userPlayers = await UserPlayer.find({
      userId: teamId,
      isActive: true
    }).populate('playerId', 'name type role basePrice style overallScore profilePicture').sort({ teamOrder: 1 });

    // Format players data
    const players = userPlayers.map(up => ({
      id: up.playerId._id,
      name: up.playerId.name,
      type: up.playerId.type,
      role: up.playerId.role,
      basePrice: up.playerId.basePrice,
      style: up.playerId.style,
      overallScore: up.playerId.overallScore,
      profilePicture: up.playerId.profilePicture,
      boughtValue: up.bidValue,
      isCaptain: up.playerId.name === team.captain,
      isViceCaptain: up.playerId.name === team.viceCaptain,
      teamOrder: up.teamOrder // Include teamOrder for debugging
    }));

    console.log('Team players with teamOrder:', players.map(p => ({ 
      name: p.name, 
      teamOrder: p.teamOrder 
    })));

    // Players are already sorted by teamOrder from the database query
    // No additional sorting needed - respect the custom order set by users

    res.json({
      success: true,
      team: {
        id: team._id,
        teamName: team.teamName,
        teamImage: team.teamImage,
        captain: team.captain,
        viceCaptain: team.viceCaptain,
        teamColor: team.teamColor,
        teamBrief: team.teamBrief,
        trophiesWon: team.trophiesWon,
        teamMotto: team.teamMotto,
        group: team.group,
        players: players
      }
    });
  } catch (error) {
    console.error('Error fetching team details:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Get player names for dropdown (for captain/vice-captain selection)
router.get('/teams/:teamId/players', async (req, res) => {
  try {
    const { teamId } = req.params;
    
    const user = await User.findById(teamId).select('captain viceCaptain');
    const userPlayers = await UserPlayer.find({
      userId: teamId,
      isActive: true
    }).populate('playerId', 'name type role').sort({ teamOrder: 1 });

    const players = userPlayers.map(up => ({
      id: up.playerId._id,
      name: up.playerId.name,
      type: up.playerId.type,
      role: up.playerId.role,
      isCaptain: up.playerId.name === user.captain,
      isViceCaptain: up.playerId.name === user.viceCaptain
    }));

    res.json({
      success: true,
      players: players
    });
  } catch (error) {
    console.error('Error fetching team players:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Update player order for team showcase
router.put('/teams/:id/player-order', async (req, res) => {
  try {
    const userId = req.params.id;
    const { playerOrders } = req.body; // Array of { playerId, order }
    
    console.log('Received userId:', userId);
    console.log('Received playerOrders:', playerOrders);
    
    if (!Array.isArray(playerOrders)) {
      return res.status(400).json({ success: false, message: 'Player orders must be an array.' });
    }
    
    if (!userId || userId === 'undefined') {
      return res.status(400).json({ success: false, message: 'Invalid team ID.' });
    }
    
    // Update each player's order in UserPlayer collection
    const updatePromises = playerOrders.map(async ({ playerId, order }) => {
      if (!playerId || !order) {
        console.log('Invalid player data:', { playerId, order });
        return null;
      }
      
      return UserPlayer.findOneAndUpdate(
        { userId: userId, playerId: playerId, isActive: true },
        { teamOrder: order },
        { new: true }
      );
    });
    
    const results = await Promise.all(updatePromises);
    const validResults = results.filter(result => result !== null);
    
    console.log('Updated players:', validResults.length);
    console.log('Updated player orders:', validResults.map(r => ({ 
      playerId: r.playerId, 
      teamOrder: r.teamOrder 
    })));
    
    res.json({ success: true, message: `Player order updated successfully. Updated ${validResults.length} players.` });
  } catch (error) {
    console.error('Error updating player order:', error);
    res.status(500).json({ success: false, message: 'Failed to update player order.' });
  }
});

module.exports = router;
