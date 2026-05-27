/**
 * Participating Teams Management - Admin routes to mark teams as participating/not participating
 */
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { applyParticipationChanges } = require('../utils/participationSyncService');

/**
 * GET /api/participating-teams
 * Get all teams with their participation status
 */
router.get('/', async (req, res) => {
  try {
    const teams = await User.find({ isActive: true, isAdmin: false })
      .select('_id name teamName abbreviation isParticipating')
      .sort({ teamName: 1 });
    
    res.json({
      success: true,
      teams: teams.map(t => ({
        id: t._id.toString(),
        name: t.name,
        teamName: t.teamName,
        abbreviation: t.abbreviation,
        isParticipating: t.isParticipating !== false,
      })),
    });
  } catch (error) {
    console.error('Error loading participating teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load teams',
      error: error.message,
    });
  }
});

/**
 * POST /api/participating-teams/update
 * Update participation status for multiple teams and sync fixtures / playoffs.
 */
router.post('/update', async (req, res) => {
  try {
    const { teamUpdates } = req.body;
    
    console.log('📝 Participation update request received:');
    console.log(`   Total teams to update: ${teamUpdates?.length || 0}`);
    
    if (!Array.isArray(teamUpdates)) {
      return res.status(400).json({
        success: false,
        message: 'teamUpdates must be an array',
      });
    }

    const io = req.app?.get?.('io');
    const result = await applyParticipationChanges(teamUpdates, { io });
    
    console.log('✅ Updated participation status:');
    result.updateDetails.forEach((detail) => {
      console.log(`   - ${detail.team}: ${detail.status}`);
    });

    if (result.participationChanged) {
      console.log(`   Fixtures added: ${result.fixturesAdded}`);
      console.log(`   Fixtures removed: ${result.fixturesRemoved}`);
      console.log(`   Required games: ${result.newRequiredGames}`);
      if (result.playoffsReset) {
        console.log('   Playoff fixtures reset');
      }
    }
    
    res.json({
      success: true,
      message: result.participationChanged
        ? `Updated ${result.updated} team(s). Added ${result.fixturesAdded} fixture(s), removed ${result.fixturesRemoved} pending fixture(s).`
        : `Updated ${result.updated} team(s)`,
      ...result,
    });
  } catch (error) {
    console.error('❌ Error updating participating teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update teams',
      error: error.message,
    });
  }
});

module.exports = router;
