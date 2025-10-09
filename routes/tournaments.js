const express = require('express');
const router = express.Router();
const Tournament = require('../models/Tournament');
const User = require('../models/User');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = 'uploads/tournaments';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Middleware to check if user is admin - removed backend check, handled in frontend
const isAdmin = async (req, res, next) => {
  try {
    const userId = req.headers['user-id'];
    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(401).json({ error: 'User ID required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove admin check - let frontend handle admin permissions
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Middleware to check if user is authenticated
const isAuthenticated = async (req, res, next) => {
  try {
    const userId = req.headers['user-id'];
    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(401).json({ error: 'User ID required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/tournaments - Get all tournaments with filters
router.get('/', isAuthenticated, async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const query = { isActive: true };
    
    if (status && ['upcoming', 'running', 'completed'].includes(status)) {
      query.status = status;
    }

    const tournaments = await Tournament.find(query)
      .populate('subscribedTeams.userId', 'name teamName teamImage')
      .populate('createdBy', 'name teamName')
      .sort({ startDate: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Tournament.countDocuments(query);

    // Add subscription status for current user
    const tournamentsWithUserStatus = tournaments.map(tournament => ({
      ...tournament,
      subscriptionCount: tournament.subscribedTeams.length,
      slotsLeft: tournament.maxSlots - tournament.subscribedTeams.length,
      isUserSubscribed: tournament.subscribedTeams.some(
        team => team.userId._id.toString() === req.user._id.toString()
      ),
      subscribedTeams: tournament.subscribedTeams.map(team => ({
        ...team,
        userId: team.userId._id,
        teamName: team.userId.teamName || team.teamName,
        teamImage: team.userId.teamImage || team.teamImage
      }))
    }));

    res.json({
      tournaments: tournamentsWithUserStatus,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    console.error('Get tournaments error:', error);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

// GET /api/tournaments/subscription-count - Get user's subscription count
router.get('/subscription-count', isAuthenticated, async (req, res) => {
  try {
    const userTournamentCount = await Tournament.countDocuments({
      'subscribedTeams.userId': req.user._id,
      isActive: true
    });

    res.json({ subscriptionCount: userTournamentCount });
  } catch (error) {
    console.error('Get subscription count error:', error);
    res.status(500).json({ error: 'Failed to fetch subscription count' });
  }
});

// GET /api/tournaments/:id - Get single tournament
router.get('/:id', isAuthenticated, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('subscribedTeams.userId', 'name teamName teamImage')
      .populate('createdBy', 'name teamName');

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const tournamentWithUserStatus = {
      ...tournament.toObject(),
      subscriptionCount: tournament.subscribedTeams.length,
      slotsLeft: tournament.maxSlots - tournament.subscribedTeams.length,
      isUserSubscribed: tournament.isUserSubscribed(req.user._id),
      subscribedTeams: tournament.subscribedTeams.map(team => ({
        ...team,
        userId: team.userId._id,
        teamName: team.userId.teamName || team.teamName,
        teamImage: team.userId.teamImage || team.teamImage
      }))
    };

    res.json(tournamentWithUserStatus);
  } catch (error) {
    console.error('Get tournament error:', error);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

// POST /api/tournaments - Create new tournament (admin only)
router.post('/', isAdmin, upload.single('tournamentImage'), async (req, res) => {
  try {
    const { name, description, startDate, endDate, maxSlots } = req.body;

    // Validate required fields
    if (!name || !startDate || !endDate || !maxSlots) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start >= end) {
      return res.status(400).json({ error: 'End date must be after start date' });
    }

    // Validate max slots
    const slots = parseInt(maxSlots);
    if (slots < 1 || slots > 20) {
      return res.status(400).json({ error: 'Max slots must be between 1 and 20' });
    }

    const tournamentData = {
      name,
      description: description || '',
      startDate: start,
      endDate: end,
      maxSlots: slots,
      createdBy: req.user._id,
      subscribedTeams: []
    };

    if (req.file) {
      tournamentData.tournamentImage = `/uploads/tournaments/${req.file.filename}`;
    }

    const tournament = new Tournament(tournamentData);
    await tournament.save();

    await tournament.populate('createdBy', 'name teamName');

    res.status(201).json(tournament);
  } catch (error) {
    console.error('Create tournament error:', error);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

// PUT /api/tournaments/:id - Update tournament (admin only)
router.put('/:id', isAdmin, upload.single('tournamentImage'), async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const { name, description, startDate, endDate, maxSlots } = req.body;

    // Validate dates if provided
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (start >= end) {
        return res.status(400).json({ error: 'End date must be after start date' });
      }
      tournament.startDate = start;
      tournament.endDate = end;
    }

    // Validate max slots if provided
    if (maxSlots) {
      const slots = parseInt(maxSlots);
      if (slots < 1 || slots > 20) {
        return res.status(400).json({ error: 'Max slots must be between 1 and 20' });
      }
      if (slots < tournament.subscribedTeams.length) {
        return res.status(400).json({ error: 'Cannot reduce slots below current subscriptions' });
      }
      tournament.maxSlots = slots;
    }

    if (name) tournament.name = name;
    if (description !== undefined) tournament.description = description;

    if (req.file) {
      // Delete old image if exists
      if (tournament.tournamentImage) {
        const oldImagePath = path.join(__dirname, '..', tournament.tournamentImage);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      tournament.tournamentImage = `/uploads/tournaments/${req.file.filename}`;
    }

    await tournament.save();

    res.json(tournament);
  } catch (error) {
    console.error('Update tournament error:', error);
    res.status(500).json({ error: 'Failed to update tournament' });
  }
});

// POST /api/tournaments/:id/subscribe - Subscribe to tournament
router.post('/:id/subscribe', isAuthenticated, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.status === 'completed') {
      return res.status(400).json({ error: 'Cannot subscribe to completed tournament' });
    }

    if (tournament.isUserSubscribed(req.user._id)) {
      return res.status(400).json({ error: 'Already subscribed to this tournament' });
    }

    // Admin cannot subscribe to tournaments
    if (req.user.isAdmin) {
      return res.status(400).json({ error: 'Admin users cannot subscribe to tournaments' });
    }

    // Check subscription limit (max 2 tournaments per user)
    const userTournamentCount = await Tournament.countDocuments({
      'subscribedTeams.userId': req.user._id,
      isActive: true
    });

    if (userTournamentCount >= 2) {
      return res.status(400).json({ 
        error: 'Maximum tournament subscription limit reached. You can only subscribe to 2 tournaments at a time. Please withdraw from one tournament first.' 
      });
    }

    await tournament.subscribeUser(
      req.user._id,
      req.user.teamName || req.user.name,
      req.user.teamImage
    );

    res.json({ message: 'Successfully subscribed to tournament' });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: error.message || 'Failed to subscribe to tournament' });
  }
});

// DELETE /api/tournaments/:id/subscribe - Unsubscribe from tournament
router.delete('/:id/subscribe', isAuthenticated, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.status === 'completed') {
      return res.status(400).json({ error: 'Cannot unsubscribe from completed tournament' });
    }

    if (tournament.isLocked) {
      return res.status(400).json({ error: 'Cannot withdraw from locked tournament' });
    }

    if (!tournament.isUserSubscribed(req.user._id)) {
      return res.status(400).json({ error: 'Not subscribed to this tournament' });
    }

    await tournament.unsubscribeUser(req.user._id);

    res.json({ message: 'Successfully unsubscribed from tournament' });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: error.message || 'Failed to unsubscribe from tournament' });
  }
});

// DELETE /api/tournaments/:id/teams/:userId - Remove team from tournament (admin only)
router.delete('/:id/teams/:userId', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    await tournament.removeTeamSubscription(req.params.userId);

    res.json({ message: 'Team removed from tournament' });
  } catch (error) {
    console.error('Remove team error:', error);
    res.status(500).json({ error: 'Failed to remove team from tournament' });
  }
});

// POST /api/tournaments/:id/lock - Lock/Unlock tournament (admin only)
router.post('/:id/lock', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    await tournament.toggleLock();

    res.json({ 
      message: `Tournament ${tournament.isLocked ? 'locked' : 'unlocked'} successfully`,
      isLocked: tournament.isLocked
    });
  } catch (error) {
    console.error('Toggle tournament lock error:', error);
    res.status(500).json({ error: 'Failed to toggle tournament lock' });
  }
});

// DELETE /api/tournaments/:id - Delete tournament (admin only)
router.delete('/:id', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Delete tournament image if exists
    if (tournament.tournamentImage) {
      const imagePath = path.join(__dirname, '..', tournament.tournamentImage);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    await Tournament.findByIdAndDelete(req.params.id);

    res.json({ message: 'Tournament deleted successfully' });
  } catch (error) {
    console.error('Delete tournament error:', error);
    res.status(500).json({ error: 'Failed to delete tournament' });
  }
});

// GET /api/tournaments/:id/fixtures - Get tournament fixtures
router.get('/:id/fixtures', isAuthenticated, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('subscribedTeams.userId', 'teamName teamImage boughtPlayers');

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Populate tournament fixtures with team details (like main fixture)
    const teams = await User.find({
      teamName: { $exists: true, $ne: null },
      isActive: true
    })
    .populate('boughtPlayers')
    .select('teamName teamImage boughtPlayers');

    // Enhance fixtures with team details
    const enhancedFixtures = tournament.tournamentFixtures.map((fixture) => {
      const team1Details = teams.find(t => t.teamName === fixture.team1) || {};
      const team2Details = teams.find(t => t.teamName === fixture.team2) || {};

      return {
        ...fixture.toObject(),
        team1Details: {
          teamName: team1Details.teamName || fixture.team1,
          teamImage: team1Details.teamImage || null,
          players: team1Details.boughtPlayers || []
        },
        team2Details: {
          teamName: team2Details.teamName || fixture.team2,
          teamImage: team2Details.teamImage || null,
          players: team2Details.boughtPlayers || []
        }
      };
    });

    res.json({ fixtures: enhancedFixtures });
  } catch (error) {
    console.error('Get tournament fixtures error:', error);
    res.status(500).json({ error: 'Failed to fetch tournament fixtures' });
  }
});

// GET /api/tournaments/:id/point-table - Get tournament point table
router.get('/:id/point-table', isAuthenticated, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Sort by points (desc) then by fairness (desc)
    const sortedPointTable = tournament.pointTable.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.fairness - a.fairness;
    });

    res.json({ pointTable: sortedPointTable });
  } catch (error) {
    console.error('Get tournament point table error:', error);
    res.status(500).json({ error: 'Failed to fetch tournament point table' });
  }
});

// POST /api/tournaments/:id/generate-fixtures - Generate round-robin fixtures (admin only)
router.post('/:id/generate-fixtures', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('subscribedTeams.userId', 'teamName');
    
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Get all subscribed team names
    const teams = tournament.subscribedTeams.map(team => 
      team.userId?.teamName || team.teamName
    );

    if (teams.length < 2) {
      return res.status(400).json({ error: 'At least 2 teams required to generate fixtures' });
    }

    // Generate round-robin fixtures (each team plays every other team once)
    const fixtures = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const fixture = {
          team1: teams[i],
          team2: teams[j],
          winner: null,
          margin: null,
          team1Score: null,
          team2Score: null,
          team1Fairness: 0,
          team2Fairness: 0,
          mom: {
            name: null,
            score: null,
            wickets: null
          },
          createdAt: new Date()
        };

        fixtures.push(fixture);
        tournament.tournamentFixtures.push(fixture);
      }
    }

    await tournament.save();

    // Initialize point table with all teams
    await updateTournamentPointTable(tournament._id);

    res.status(201).json({ 
      message: `Generated ${fixtures.length} fixtures for round-robin tournament`,
      fixtures,
      teamsCount: teams.length
    });
  } catch (error) {
    console.error('Generate tournament fixtures error:', error);
    res.status(500).json({ error: 'Failed to generate tournament fixtures' });
  }
});

// PUT /api/tournaments/:id/fixtures/:fixtureIndex - Update tournament fixture (admin only)
router.put('/:id/fixtures/:fixtureIndex', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const fixtureIndex = parseInt(req.params.fixtureIndex);
    if (fixtureIndex < 0 || fixtureIndex >= tournament.tournamentFixtures.length) {
      return res.status(404).json({ error: 'Fixture not found' });
    }

    const { winner, margin, team1Score, team2Score, team1Fairness, team2Fairness, mom } = req.body;

    // Update the fixture in the array
    if (winner !== undefined) tournament.tournamentFixtures[fixtureIndex].winner = winner;
    if (margin !== undefined) tournament.tournamentFixtures[fixtureIndex].margin = margin;
    if (team1Score !== undefined) tournament.tournamentFixtures[fixtureIndex].team1Score = team1Score;
    if (team2Score !== undefined) tournament.tournamentFixtures[fixtureIndex].team2Score = team2Score;
    if (team1Fairness !== undefined) tournament.tournamentFixtures[fixtureIndex].team1Fairness = team1Fairness;
    if (team2Fairness !== undefined) tournament.tournamentFixtures[fixtureIndex].team2Fairness = team2Fairness;
    if (mom !== undefined) tournament.tournamentFixtures[fixtureIndex].mom = mom;

    await tournament.save();

    // Auto-update point table when winner is set
    if (winner) {
      await updateTournamentPointTable(tournament._id);
    }

    res.json({ message: 'Fixture updated successfully', fixture: tournament.tournamentFixtures[fixtureIndex] });
  } catch (error) {
    console.error('Update tournament fixture error:', error);
    res.status(500).json({ error: 'Failed to update tournament fixture' });
  }
});

// Helper function to update tournament point table
const updateTournamentPointTable = async (tournamentId) => {
  try {
    const tournament = await Tournament.findById(tournamentId)
      .populate('subscribedTeams.userId', 'teamName');

    if (!tournament) return;

    // Initialize point table with all subscribed teams
    const pointTable = {};
    tournament.subscribedTeams.forEach(team => {
      const teamName = team.userId?.teamName || team.teamName;
      pointTable[teamName] = {
        teamName: teamName,
        matches: 0,
        won: 0,
        lost: 0,
        points: 0,
        fairness: 0
      };
    });

    // Process embedded tournament fixtures
    tournament.tournamentFixtures.forEach(fixture => {
      if (fixture.winner) {
        // Update matches played
        if (pointTable[fixture.team1]) pointTable[fixture.team1].matches++;
        if (pointTable[fixture.team2]) pointTable[fixture.team2].matches++;

        // Update wins/losses
        if (fixture.winner === fixture.team1) {
          if (pointTable[fixture.team1]) {
            pointTable[fixture.team1].won++;
            pointTable[fixture.team1].points += 2;
          }
          if (pointTable[fixture.team2]) {
            pointTable[fixture.team2].lost++;
          }
        } else if (fixture.winner === fixture.team2) {
          if (pointTable[fixture.team2]) {
            pointTable[fixture.team2].won++;
            pointTable[fixture.team2].points += 2;
          }
          if (pointTable[fixture.team1]) {
            pointTable[fixture.team1].lost++;
          }
        }
      }
    });

    // Calculate fairness - sum of team fairness from all fixtures
    tournament.tournamentFixtures.forEach(fixture => {
      if (fixture.team1Fairness && pointTable[fixture.team1]) {
        pointTable[fixture.team1].fairness += fixture.team1Fairness;
      }
      if (fixture.team2Fairness && pointTable[fixture.team2]) {
        pointTable[fixture.team2].fairness += fixture.team2Fairness;
      }
    });

    // Update tournament point table
    tournament.pointTable = Object.values(pointTable);
    await tournament.save();

    console.log(`Updated point table for tournament ${tournamentId} with ${Object.keys(pointTable).length} teams`);
  } catch (error) {
    console.error('Error updating tournament point table:', error);
  }
};

module.exports = router;
