/**
 * Participating Teams Management - Admin routes to mark teams as participating/not participating
 */
const express = require('express');
const router = express.Router();
const User = require('../models/User');

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
 * Update participation status for multiple teams
 */
router.post('/update', async (req, res) => {
  try {
    const { teamUpdates } = req.body;
    // teamUpdates: [{ teamId, isParticipating }]
    
    console.log('📝 Participation update request received:');
    console.log(`   Total teams to update: ${teamUpdates?.length || 0}`);
    
    if (!Array.isArray(teamUpdates)) {
      return res.status(400).json({
        success: false,
        message: 'teamUpdates must be an array',
      });
    }
    
    let updated = 0;
    const updateDetails = [];
    
    for (const { teamId, isParticipating } of teamUpdates) {
      const team = await User.findById(teamId).select('teamName');
      const newStatus = !!isParticipating;
      
      await User.findByIdAndUpdate(teamId, {
        $set: { isParticipating: newStatus },
      });
      
      updateDetails.push({
        team: team?.teamName || teamId,
        status: newStatus ? 'PARTICIPATING' : 'NOT PARTICIPATING'
      });
      updated++;
    }
    
    console.log('✅ Updated participation status:');
    updateDetails.forEach(detail => {
      console.log(`   - ${detail.team}: ${detail.status}`);
    });
    
    res.json({
      success: true,
      message: `Updated ${updated} team(s)`,
      updated,
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
