const express = require('express');
const router = express.Router();
const MatchResult = require('../models/MatchResult');
const User = require('../models/User');
const Player = require('../models/Player');

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  const userId = req.headers['user-id'];
  if (!userId || userId === 'undefined' || userId === 'null') {
    return res.status(401).json({ error: 'User not authenticated' });
  }
  req.userId = userId;
  next();
};

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Remove admin check - let frontend handle admin permissions
    req.user = user;
    next();
  } catch (error) {
    console.error('Error checking admin status:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/match-results/public - Get all match results (public for trophy hall)
router.get('/public', async (req, res) => {
  try {
    const matchResults = await MatchResult.find({})
      .populate('manOfTheMatch.playerId', 'name role')
      .sort({ matchDate: -1, createdAt: -1 });

    res.json({
      matchResults,
      total: matchResults.length
    });
  } catch (error) {
    console.error('Error fetching public match results:', error);
    res.status(500).json({ error: 'Failed to fetch match results' });
  }
});

// GET /api/match-results - Get all match results (admin only)
router.get('/', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', matchType = '', trophyType = '' } = req.query;
    
    // Build query
    const query = {};
    if (search) {
      query.$or = [
        { matchTitle: { $regex: search, $options: 'i' } },
        { team1: { $regex: search, $options: 'i' } },
        { team2: { $regex: search, $options: 'i' } },
        { trophyName: { $regex: search, $options: 'i' } }
      ];
    }
    if (matchType) {
      query.matchType = matchType;
    }
    if (trophyType) {
      query.trophyType = trophyType;
    }

    const skip = (page - 1) * limit;
    
    const matchResults = await MatchResult.find(query)
      .populate('manOfTheMatch.playerId', 'name role')
      .populate('createdBy', 'name teamName')
      .sort({ matchDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await MatchResult.countDocuments(query);

    res.json({
      matchResults,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalResults: total,
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching match results:', error);
    res.status(500).json({ error: 'Failed to fetch match results' });
  }
});

// GET /api/match-results/:id - Get specific match result
router.get('/:id', isAuthenticated, async (req, res) => {
  try {
    const matchResult = await MatchResult.findById(req.params.id)
      .populate('manOfTheMatch.playerId', 'name role team')
      .populate('createdBy', 'name teamName');

    if (!matchResult) {
      return res.status(404).json({ error: 'Match result not found' });
    }

    res.json(matchResult);
  } catch (error) {
    console.error('Error fetching match result:', error);
    res.status(500).json({ error: 'Failed to fetch match result' });
  }
});

// POST /api/match-results - Create new match result (admin only)
router.post('/', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const {
      matchNumber,
      matchTitle,
      team1,
      team2,
      winner,
      team1Score,
      team2Score,
      team1Wickets,
      team2Wickets,
      team1Overs,
      team2Overs,
      matchDate,
      matchVenue,
      manOfTheMatch,
      trophyName,
      trophyType,
      matchType,
      margin,
      matchStatus,
      additionalNotes
    } = req.body;

    // Validate required fields
    if (!matchNumber || !matchTitle || !team1 || !team2 || !winner || 
        team1Score === undefined || team2Score === undefined || 
        !matchDate || !matchVenue || !manOfTheMatch || !trophyName || !margin) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate MoM data
    if (!manOfTheMatch.name || !manOfTheMatch.team) {
      return res.status(400).json({ error: 'Man of the Match name and team are required' });
    }

    // Use smart match result creation to prevent duplicates
    const { createOrUpdateMatchResult } = require('../utils/teamNameUpdater');
    
    console.log(`🎯 Creating match result: ${team1} vs ${team2} (${matchTitle})`);
    
    const matchData = {
      matchNumber,
      matchTitle,
      team1,
      team2,
      winner,
      team1Score,
      team2Score,
      team1Wickets: team1Wickets || 0,
      team2Wickets: team2Wickets || 0,
      team1Overs: team1Overs || 0,
      team2Overs: team2Overs || 0,
      matchDate: new Date(matchDate),
      matchVenue,
      manOfTheMatch: {
        name: manOfTheMatch.name,
        playerId: (manOfTheMatch.playerId && manOfTheMatch.playerId !== '') ? manOfTheMatch.playerId : null,
        team: manOfTheMatch.team,
        runs: manOfTheMatch.runs || 0,
        wickets: manOfTheMatch.wickets || 0,
        balls: manOfTheMatch.balls || 0
      },
      trophyName,
      trophyType: trophyType || 'league',
      matchType: matchType || 'normal',
      margin,
      matchStatus: matchStatus || 'completed',
      additionalNotes: additionalNotes || '',
      createdBy: req.userId
    };

    const matchResult = await createOrUpdateMatchResult(matchData);

    // Populate the created match result
    const populatedMatchResult = await MatchResult.findById(matchResult._id)
      .populate('manOfTheMatch.playerId', 'name role')
      .populate('createdBy', 'name teamName');

    res.status(201).json({
      message: 'Match result created successfully',
      matchResult: populatedMatchResult
    });
  } catch (error) {
    console.error('Error creating match result:', error);
    if (error.code === 11000) {
      res.status(400).json({ error: 'Match number already exists' });
    } else if (error.message.includes('Match result already exists')) {
      res.status(400).json({ error: error.message });
    } else if (error.message.includes('Match number') && error.message.includes('already exists')) {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to create match result' });
    }
  }
});

// PUT /api/match-results/:id - Update match result (admin only)
router.put('/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Use smart match result update for team name consistency
    const { updateMatchResultConsistently } = require('../utils/teamNameUpdater');
    
    console.log(`🎯 Updating match result ID: ${req.params.id}`);
    
    // Prepare update data
    const updateData = {};
    const allowedUpdates = [
      'matchTitle', 'team1', 'team2', 'winner', 'team1Score', 'team2Score',
      'team1Wickets', 'team2Wickets', 'team1Overs', 'team2Overs', 'matchDate',
      'matchVenue', 'manOfTheMatch', 'trophyName', 'trophyType', 'matchType',
      'margin', 'matchStatus', 'additionalNotes'
    ];

    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'manOfTheMatch' && req.body[field]) {
          // Handle manOfTheMatch specially to convert empty string playerId to null
          const momData = { ...req.body[field] };
          if (momData.playerId === '' || momData.playerId === null) {
            momData.playerId = null;
          }
          updateData[field] = momData;
        } else {
          updateData[field] = req.body[field];
        }
      }
    });

    // Convert matchDate if provided
    if (updateData.matchDate) {
      updateData.matchDate = new Date(updateData.matchDate);
    }

    const updatedMatchResult = await updateMatchResultConsistently(req.params.id, updateData);

    // Populate the updated match result
    const populatedMatchResult = await MatchResult.findById(updatedMatchResult._id)
      .populate('manOfTheMatch.playerId', 'name role')
      .populate('createdBy', 'name teamName');

    res.json({
      message: 'Match result updated successfully',
      matchResult: populatedMatchResult
    });
  } catch (error) {
    console.error('Error updating match result:', error);
    if (error.message.includes('not found')) {
      res.status(404).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to update match result' });
    }
  }
});

// DELETE /api/match-results/:id - Delete match result (admin only)
router.delete('/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const matchResult = await MatchResult.findById(req.params.id);
    
    if (!matchResult) {
      return res.status(404).json({ error: 'Match result not found' });
    }

    await MatchResult.findByIdAndDelete(req.params.id);

    res.json({ message: 'Match result deleted successfully' });
  } catch (error) {
    console.error('Error deleting match result:', error);
    res.status(500).json({ error: 'Failed to delete match result' });
  }
});

// GET /api/match-results/stats/summary - Get match statistics summary (admin only)
router.get('/stats/summary', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const totalMatches = await MatchResult.countDocuments();
    const completedMatches = await MatchResult.countDocuments({ matchStatus: 'completed' });
    const abandonedMatches = await MatchResult.countDocuments({ matchStatus: 'abandoned' });
    
    const trophyStats = await MatchResult.aggregate([
      {
        $group: {
          _id: '$trophyName',
          count: { $sum: 1 },
          latestMatch: { $max: '$matchDate' }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const teamStats = await MatchResult.aggregate([
      {
        $group: {
          _id: null,
          team1Wins: { $sum: { $cond: [{ $eq: ['$winner', 'team1'] }, 1, 0] } },
          team2Wins: { $sum: { $cond: [{ $eq: ['$winner', 'team2'] }, 1, 0] } },
          ties: { $sum: { $cond: [{ $eq: ['$winner', 'tie'] }, 1, 0] } },
          noResults: { $sum: { $cond: [{ $eq: ['$winner', 'no_result'] }, 1, 0] } }
        }
      }
    ]);

    res.json({
      totalMatches,
      completedMatches,
      abandonedMatches,
      trophyStats,
      teamStats: teamStats[0] || { team1Wins: 0, team2Wins: 0, ties: 0, noResults: 0 }
    });
  } catch (error) {
    console.error('Error fetching match statistics:', error);
    res.status(500).json({ error: 'Failed to fetch match statistics' });
  }
});

// GET /api/match-results/teams/list - Get list of teams for dropdowns
router.get('/teams/list', isAuthenticated, async (req, res) => {
  try {
    const teams = await User.find({ 
      isActive: true,
      isAdmin: { $ne: true }, // Exclude admin accounts
      teamName: { $exists: true, $ne: null, $ne: 'NA' } // Only valid team names
    })
      .select('teamName abbreviation _id')
      .sort({ teamName: 1 });

    console.log(`📋 Fetched ${teams.length} teams for match result dropdowns`);
    res.json(teams);
  } catch (error) {
    console.error('Error fetching teams list:', error);
    res.status(500).json({ error: 'Failed to fetch teams list' });
  }
});

// GET /api/match-results/players/list - Get list of players for MoM dropdown
router.get('/players/list', isAuthenticated, async (req, res) => {
  try {
    const players = await Player.find({ isActive: true, isSold: true })
      .select('name role _id')
      .sort({ name: 1 });

    res.json(players);
  } catch (error) {
    console.error('Error fetching players list:', error);
    res.status(500).json({ error: 'Failed to fetch players list' });
  }
});

// Admin route to check for match result duplicates
router.get('/admin/check-duplicates', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('🔍 Checking for match result duplicates...');
    
    const allMatchResults = await MatchResult.find({})
      .sort({ matchDate: -1, createdAt: -1 });
    
    const duplicateGroups = new Map();
    
    // Group match results by team combinations
    allMatchResults.forEach(match => {
      const sortedKey = [match.team1, match.team2].sort().join(' vs ');
      
      if (!duplicateGroups.has(sortedKey)) {
        duplicateGroups.set(sortedKey, []);
      }
      duplicateGroups.get(sortedKey).push(match);
    });
    
    // Find actual duplicates (more than one match for same teams)
    const duplicates = [];
    duplicateGroups.forEach((matches, teamCombo) => {
      if (matches.length > 1) {
        duplicates.push({
          teams: teamCombo,
          count: matches.length,
          matches: matches.map(m => ({
            id: m._id,
            matchNumber: m.matchNumber,
            matchTitle: m.matchTitle,
            winner: m.winner,
            matchDate: m.matchDate,
            createdAt: m.createdAt
          }))
        });
      }
    });
    
    console.log(`📊 Found ${duplicates.length} duplicate team combinations in match results`);
    
    res.json({
      message: `Found ${duplicates.length} duplicate team combinations`,
      totalMatchResults: allMatchResults.length,
      duplicateGroups: duplicates,
      summary: {
        totalMatches: allMatchResults.length,
        uniqueTeamCombinations: duplicateGroups.size,
        duplicateCombinations: duplicates.length,
        totalDuplicates: duplicates.reduce((sum, group) => sum + (group.count - 1), 0)
      }
    });
  } catch (error) {
    console.error('Error checking match result duplicates:', error);
    res.status(500).json({ error: 'Failed to check match result duplicates' });
  }
});

// Admin route to clean up match result duplicates
router.post('/admin/cleanup-duplicates', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('🧹 Starting match result duplicate cleanup...');
    
    const { findExistingMatchResult } = require('../utils/teamNameUpdater');
    
    const allMatchResults = await MatchResult.find({})
      .sort({ matchDate: -1, createdAt: -1 });
    
    const duplicateGroups = new Map();
    const duplicatesToDelete = [];
    
    // Group match results by team combinations
    allMatchResults.forEach(match => {
      const sortedKey = [match.team1, match.team2].sort().join('-');
      
      if (!duplicateGroups.has(sortedKey)) {
        duplicateGroups.set(sortedKey, []);
      }
      duplicateGroups.get(sortedKey).push(match);
    });
    
    // Process duplicates - keep the most appropriate one
    duplicateGroups.forEach((matches, teamCombo) => {
      if (matches.length > 1) {
        console.log(`🔍 Processing duplicates for: ${teamCombo} (${matches.length} matches)`);
        
        // Sort by priority: completed matches first, then by creation date (newest first)
        matches.sort((a, b) => {
          // Prioritize completed matches
          if (a.matchStatus === 'completed' && b.matchStatus !== 'completed') return -1;
          if (a.matchStatus !== 'completed' && b.matchStatus === 'completed') return 1;
          
          // Then by creation date (keep newer)
          return new Date(b.createdAt) - new Date(a.createdAt);
        });
        
        const keepMatch = matches[0];
        console.log(`✅ Keeping: ${keepMatch.matchTitle} (${keepMatch.matchNumber})`);
        
        // Mark others for deletion
        for (let i = 1; i < matches.length; i++) {
          const deleteMatch = matches[i];
          console.log(`🗑️  Deleting: ${deleteMatch.matchTitle} (${deleteMatch.matchNumber})`);
          duplicatesToDelete.push(deleteMatch._id);
        }
      }
    });
    
    let deletedCount = 0;
    if (duplicatesToDelete.length > 0) {
      const deleteResult = await MatchResult.deleteMany({ _id: { $in: duplicatesToDelete } });
      deletedCount = deleteResult.deletedCount;
      console.log(`🗑️  Deleted ${deletedCount} duplicate match results`);
    }
    
    const finalCount = await MatchResult.countDocuments({});
    
    res.json({
      message: `Match result cleanup completed. Deleted ${deletedCount} duplicates.`,
      deletedCount,
      remainingMatchResults: finalCount,
      originalCount: allMatchResults.length
    });
  } catch (error) {
    console.error('Error during match result cleanup:', error);
    res.status(500).json({ error: 'Failed to cleanup match results' });
  }
});

// Admin route to check match result and team name consistency
router.get('/admin/check-consistency', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('🔍 Checking match result team name consistency...');
    
    const matchResults = await MatchResult.find({});
    const activeTeams = await User.find({ 
      isActive: true, 
      isAdmin: { $ne: true },
      teamName: { $exists: true, $ne: null, $ne: 'NA' }
    }).select('teamName');
    
    const activeTeamNames = new Set(activeTeams.map(t => t.teamName));
    const inconsistencies = [];
    
    matchResults.forEach(match => {
      const issues = [];
      
      if (!activeTeamNames.has(match.team1)) {
        issues.push(`Team1 "${match.team1}" not found in active teams`);
      }
      
      if (!activeTeamNames.has(match.team2)) {
        issues.push(`Team2 "${match.team2}" not found in active teams`);
      }
      
      if (match.manOfTheMatch && match.manOfTheMatch.team && !activeTeamNames.has(match.manOfTheMatch.team)) {
        issues.push(`MOM team "${match.manOfTheMatch.team}" not found in active teams`);
      }
      
      if (issues.length > 0) {
        inconsistencies.push({
          matchId: match._id,
          matchTitle: match.matchTitle,
          matchNumber: match.matchNumber,
          team1: match.team1,
          team2: match.team2,
          momTeam: match.manOfTheMatch?.team,
          issues
        });
      }
    });
    
    res.json({
      message: `Found ${inconsistencies.length} match results with team name inconsistencies`,
      totalMatchResults: matchResults.length,
      activeTeams: activeTeams.length,
      inconsistencies,
      summary: {
        totalMatches: matchResults.length,
        activeTeams: activeTeams.length,
        inconsistentMatches: inconsistencies.length,
        consistencyRate: `${((matchResults.length - inconsistencies.length) / matchResults.length * 100).toFixed(1)}%`
      }
    });
  } catch (error) {
    console.error('Error checking consistency:', error);
    res.status(500).json({ error: 'Failed to check consistency' });
  }
});

module.exports = router;
