const express = require('express');
const router = express.Router();
const Tournament = require('../models/Tournament');
const User = require('../models/User');
const AppSettings = require('../models/AppSettings');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { applyCareerLeagueResult } = require('../utils/careerUserCounters');

/** Full round-robin count for n teams (each pair plays once). */
const expectedRoundRobinFixtureCount = (tournament) => {
  const n = tournament?.subscribedTeams?.length || 0;
  return n >= 2 ? (n * (n - 1)) / 2 : 0;
};

/** Knockout rows appended after RR, or legacy placeholder rows. */
const tournamentHasKnockoutStage = (tournament) => {
  const rr = expectedRoundRobinFixtureCount(tournament);
  const fx = tournament?.tournamentFixtures || [];
  if (rr > 0 && fx.length > rr) return true;
  return fx.some(
    (f) =>
      (f.team1 && (String(f.team1).includes('Winner of') || String(f.team1).includes('Top '))) ||
      (f.team2 && (String(f.team2).includes('Winner of') || String(f.team2).includes('Top ')))
  );
};

// Helper function to parse score string and extract runs
const parseRuns = (scoreString) => {
  if (!scoreString) {
    return 0;
  }
  
  const scoreStr = String(scoreString).trim();
  
  // Check for invalid values
  if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' || 
      scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
    return 0;
  }
  
  // Try to extract number - handle formats like "150", "150/5", "150-5", "150 (20.0 ov)"
  const match = scoreStr.match(/^(\d+)/);
  if (match) {
    const runs = parseInt(match[1], 10);
    return isNaN(runs) ? 0 : runs;
  }
  
  // If no match, try to parse as number directly
  const num = parseFloat(scoreStr);
  return isNaN(num) ? 0 : Math.floor(num);
};

// Helper function to parse wickets from score string (e.g., "150/10" → 10, "180/5" → 5)
const parseWickets = (scoreString) => {
  if (!scoreString) {
    return 0;
  }
  
  const scoreStr = String(scoreString).trim();
  
  // Check for invalid values
  if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' || 
      scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
    return 0;
  }
  
  // Try to extract wickets from formats like "150/10", "180/5", "150-10"
  // Pattern: number/number or number-number
  const slashMatch = scoreStr.match(/\/(\d+)/); // Match "/10" or "/5"
  if (slashMatch) {
    const wickets = parseInt(slashMatch[1], 10);
    if (!isNaN(wickets) && wickets >= 0 && wickets <= 10) {
      return wickets;
    }
  }
  
  // Try hyphen format: "150-10"
  const hyphenMatch = scoreStr.match(/-(\d+)/);
  if (hyphenMatch) {
    const wickets = parseInt(hyphenMatch[1], 10);
    if (!isNaN(wickets) && wickets >= 0 && wickets <= 10) {
      return wickets;
    }
  }
  
  // If no wickets found in score, assume 0 wickets (not all out)
  return 0;
};

// Helper function to parse overs string and convert to decimal (e.g., "20.0" -> 20.0, "19.3" -> 19.5, "18.5" -> 18.5)
const parseOvers = (oversString) => {
  if (!oversString) {
    return null; // Return null if not provided, will use default
  }
  
  const oversStr = String(oversString).trim();
  
  // Check for invalid values
  if (oversStr === 'null' || oversStr === 'TBD' || oversStr === 'NA' || 
      oversStr === '' || oversStr === 'undefined' || oversStr.toLowerCase() === 'null') {
    return null;
  }
  
  // Handle decimal format: "20.0", "19.3", "18.5"
  // Format: overs.balls where balls is 0-5
  const decimalMatch = oversStr.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch) {
    const overs = parseInt(decimalMatch[1], 10);
    const balls = parseInt(decimalMatch[2], 10);
    if (!isNaN(overs) && !isNaN(balls) && balls >= 0 && balls <= 5) {
      // Convert to decimal: overs + (balls / 6)
      return overs + (balls / 6);
    }
  }
  
  // Handle whole number format: "20" -> 20.0
  const wholeMatch = oversStr.match(/^(\d+)$/);
  if (wholeMatch) {
    const overs = parseInt(wholeMatch[1], 10);
    if (!isNaN(overs)) {
      return overs;
    }
  }
  
  // Try to parse as float directly
  const num = parseFloat(oversStr);
  if (!isNaN(num) && num >= 0) {
    return num;
  }
  
  return null; // Invalid format, will use default
};

// Calculate Net Run Rate (NRR) for a team from tournament fixtures
const calculateTournamentNRR = (fixtures, teamName) => {
  const DEFAULT_OVERS = 20; // Standard T20 format - used if overs not provided
  let totalRunsScored = 0;
  let totalRunsConceded = 0;
  let totalOversFaced = 0;
  let totalOversBowled = 0;
  let matchesCount = 0;

  fixtures.forEach((fixture) => {
    // Skip if match is not completed
    if (!fixture.winner) {
      return;
    }

    // Check if scores exist
    const score1 = fixture.team1Score;
    const score2 = fixture.team2Score;
    
    // Parse runs from scores
    const team1Runs = parseRuns(score1);
    const team2Runs = parseRuns(score2);

    // Skip if both scores are invalid (0 or couldn't parse)
    // But log a warning if scores exist but couldn't be parsed
    if (team1Runs === 0 && team2Runs === 0) {
      if (score1 || score2) {
        console.warn(`⚠️ Could not parse scores for fixture ${fixture.team1} vs ${fixture.team2}: team1Score="${score1}", team2Score="${score2}"`);
      }
      return;
    }

    // Parse wickets to check for all-out scenarios
    const team1Wickets = parseWickets(score1);
    const team2Wickets = parseWickets(score2);

    // ICC RULE: Use overs from fixture (team1Overs and team2Overs) - these are the actual overs played by both teams
    let team1OversActual = parseOvers(fixture.team1Overs) ?? DEFAULT_OVERS;
    let team2OversActual = parseOvers(fixture.team2Overs) ?? DEFAULT_OVERS;

    // ICC RULE 1 & 2: Overs FACED
    // If team is all out (10 wickets), use FULL quota (20.0 overs), otherwise use actual overs
    let team1OversFaced = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;
    let team2OversFaced = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    
    // ICC RULE 3: Overs BOWLED
    // If opposition is all out, use FULL quota (20.0 overs), otherwise use actual overs
    let team1OversBowled = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    let team2OversBowled = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;

    // Match by teamName (flexible matching to handle variations like spaces, special chars)
    const normalizeTeamName = (name) => {
      if (!name) return '';
      // Trim and normalize: remove extra spaces, convert to lowercase, remove special chars
      return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s]/g, '').trim();
    };
    const normalizedTeamName = normalizeTeamName(teamName);
    const normalizedTeam1 = normalizeTeamName(fixture.team1);
    const normalizedTeam2 = normalizeTeamName(fixture.team2);
    
    // Use includes for more flexible matching (handles partial matches)
    const isTeam1 = normalizedTeam1 && normalizedTeamName && 
                    (normalizedTeam1 === normalizedTeamName || 
                     normalizedTeam1.includes(normalizedTeamName) || 
                     normalizedTeamName.includes(normalizedTeam1));
    const isTeam2 = normalizedTeam2 && normalizedTeamName && 
                    (normalizedTeam2 === normalizedTeamName || 
                     normalizedTeam2.includes(normalizedTeamName) || 
                     normalizedTeamName.includes(normalizedTeam2));

    if (!isTeam1 && !isTeam2) {
      return; // Team not involved in this match
    }

    if (isTeam1) {
      totalRunsScored += team1Runs;
      totalRunsConceded += team2Runs;
      // ICC RULE: Overs FACED (if all out, use 20.0; otherwise actual)
      totalOversFaced += team1OversFaced;
      // ICC RULE: Overs BOWLED (if opposition all out, use 20.0; otherwise actual)
      totalOversBowled += team1OversBowled;
    } else {
      totalRunsScored += team2Runs;
      totalRunsConceded += team1Runs;
      // ICC RULE: Overs FACED (if all out, use 20.0; otherwise actual)
      totalOversFaced += team2OversFaced;
      // ICC RULE: Overs BOWLED (if opposition all out, use 20.0; otherwise actual)
      totalOversBowled += team2OversBowled;
    }

    matchesCount++;
  });

  if (matchesCount === 0) {
    return 0;
  }

  // Calculate NRR
  const runsScoredPerOver = totalOversFaced > 0 ? totalRunsScored / totalOversFaced : 0;
  const runsConcededPerOver = totalOversBowled > 0 ? totalRunsConceded / totalOversBowled : 0;
  const nrr = runsScoredPerOver - runsConcededPerOver;

  return parseFloat(nrr.toFixed(3)); // Round to 3 decimal places
};

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

// GET /api/tournaments - Get all tournaments with filters (optional authentication)
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 10, includeInactive } = req.query;
    const query = {};
    // By default we hide archived tournaments (isActive:false) so older list
    // consumers don't suddenly see ghost data. Pass ?includeInactive=true to
    // surface archived ones (e.g., the Tournaments page wants full history).
    const wantInactive = String(includeInactive).toLowerCase() === 'true';
    if (!wantInactive) {
      query.isActive = true;
    }

    if (status && ['upcoming', 'running', 'completed'].includes(status)) {
      query.status = status;
    }

    console.log('📋 Tournaments query:', JSON.stringify(query), 'limit:', limit, 'page:', page);

    // Try to get user if authenticated (optional)
    let user = null;
    const userId = req.headers['user-id'];
    if (userId && userId !== 'undefined' && userId !== 'null') {
      try {
        user = await User.findById(userId).lean();
        console.log('📋 User found:', user ? user.teamName || user.name : 'null');
      } catch (err) {
        // User not found or invalid, continue without authentication
        console.log('User authentication optional, continuing without user');
      }
    }

    // First, check if any tournaments exist at all
    const count = await Tournament.countDocuments(query);
    console.log('📋 Total tournaments matching query:', count);

    let tournaments;
    try {
      tournaments = await Tournament.find(query)
        .populate({
          path: 'subscribedTeams.userId',
          select: 'name teamName teamImage',
          model: 'User'
        })
        .populate({
          path: 'createdBy',
          select: 'name teamName',
          model: 'User'
        })
      .select('name description startDate endDate maxSlots status tournamentImage subscribedTeams createdBy isActive isLocked winner tournamentFixtures pointTable createdAt updatedAt')
      .sort({ startDate: 1 })
        .limit(parseInt(limit) || 100)
        .skip((parseInt(page) - 1) * (parseInt(limit) || 100))
      .lean();
      
      console.log('📋 Tournaments found after populate:', tournaments.length);
      if (tournaments.length > 0) {
        console.log('📋 First tournament:', {
          name: tournaments[0].name,
          isActive: tournaments[0].isActive,
          subscribedTeamsCount: tournaments[0].subscribedTeams?.length || 0
        });
      }
    } catch (populateError) {
      console.error('❌ Populate error:', populateError.message);
      console.error('❌ Error stack:', populateError.stack);
      // If populate fails, try without it
      tournaments = await Tournament.find(query)
        .select('name description startDate endDate maxSlots status tournamentImage subscribedTeams createdBy isActive isLocked winner tournamentFixtures pointTable createdAt updatedAt')
        .sort({ startDate: 1 })
        .limit(parseInt(limit) || 100)
        .skip((parseInt(page) - 1) * (parseInt(limit) || 100))
        .lean();
      console.log('📋 Tournaments found without populate:', tournaments.length);
    }

    const total = await Tournament.countDocuments(query);
    console.log('📋 Total tournaments:', total);

    // Add subscription status for current user (if authenticated)
    const tournamentsWithUserStatus = tournaments.map(tournament => ({
      ...tournament,
      subscriptionCount: tournament.subscribedTeams.length,
      slotsLeft: tournament.maxSlots - tournament.subscribedTeams.length,
      isUserSubscribed: user ? tournament.subscribedTeams.some(
        team => team.userId && team.userId._id && team.userId._id.toString() === user._id.toString()
      ) : false,
      subscribedTeams: tournament.subscribedTeams.map(team => ({
        ...team,
        userId: team.userId?._id || team.userId,
        teamName: team.userId?.teamName || team.teamName,
        teamImage: team.userId?.teamImage || team.teamImage
      })),
      // Ensure winner field is included and properly formatted
      winner: tournament.winner || null
    }));

    // Return format: 
    // - Always return array for GET requests without explicit pagination (for frontend compatibility)
    // - Only return paginated object if explicitly requested with limit < 100
    const limitNum = parseInt(limit) || 100;
    const hasExplicitLimit = req.query.limit !== undefined && limitNum < 100;
    
    console.log('📋 Return format - hasExplicitLimit:', hasExplicitLimit, 'limitNum:', limitNum, 'tournamentsWithUserStatus.length:', tournamentsWithUserStatus.length);
    
    if (hasExplicitLimit) {
      console.log('📋 Returning paginated object');
      return res.json({
        tournaments: tournamentsWithUserStatus,
        totalPages: Math.ceil(total / limitNum),
        currentPage: parseInt(page),
        total
      });
    }

    // Default: return array directly (for frontend components that expect array)
    console.log('📋 Returning array with', tournamentsWithUserStatus.length, 'tournaments');
    if (tournamentsWithUserStatus.length === 0) {
      console.log('⚠️  WARNING: Returning empty array! Query was:', JSON.stringify(query));
      console.log('⚠️  Total count was:', total);
    }
    res.json(tournamentsWithUserStatus);
  } catch (error) {
    console.error('❌ Get tournaments error:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to fetch tournaments', details: error.message });
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
    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const tournament = await Tournament.findById(req.params.id)
      .populate('subscribedTeams.userId', 'name teamName teamImage')
      .populate('createdBy', 'name teamName')
      .lean();

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

// POST /api/tournaments/:id/subscribe - Add team to tournament (admin only)
router.post('/:id/subscribe', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.status === 'completed') {
      return res.status(400).json({ error: 'Cannot add team to completed tournament' });
    }

    // Get team userId from request body (admin specifies which team to add)
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID (userId) is required to add team' });
    }

    const teamUser = await User.findById(userId);
    if (!teamUser) {
      return res.status(404).json({ error: 'Team user not found' });
    }

    if (tournament.isUserSubscribed(teamUser._id)) {
      return res.status(400).json({ error: 'Team is already subscribed to this tournament' });
    }

    if (tournament.subscribedTeams.length >= tournament.maxSlots) {
      return res.status(400).json({ error: 'Tournament is full' });
    }

    await tournament.subscribeUser(
      teamUser._id,
      teamUser.teamName || teamUser.name,
      teamUser.teamImage
    );

    // Regenerate fixtures if they already exist (to include new team)
    if (tournament.tournamentFixtures && tournament.tournamentFixtures.length > 0) {
      // Check if fixtures are round-robin (not knockout)
      const hasKnockoutFixtures = tournamentHasKnockoutStage(tournament);
      
      if (!hasKnockoutFixtures) {
        // Regenerate round-robin fixtures with all subscribed teams
        const subscribedTeamNames = tournament.subscribedTeams.map(t => t.teamName);
        const newFixtures = [];
        
        for (let i = 0; i < subscribedTeamNames.length; i++) {
          for (let j = i + 1; j < subscribedTeamNames.length; j++) {
            // Check if this fixture already exists
            const existingFixture = tournament.tournamentFixtures.find(f => 
              (f.team1 === subscribedTeamNames[i] && f.team2 === subscribedTeamNames[j]) ||
              (f.team1 === subscribedTeamNames[j] && f.team2 === subscribedTeamNames[i])
            );
            
            if (!existingFixture) {
              // Find userIds for teams
              const team1Data = tournament.subscribedTeams.find(t => t.teamName === subscribedTeamNames[i]);
              const team2Data = tournament.subscribedTeams.find(t => t.teamName === subscribedTeamNames[j]);
              
              newFixtures.push({
                team1: subscribedTeamNames[i],
                team2: subscribedTeamNames[j],
                team1UserId: team1Data?.userId || null,
                team2UserId: team2Data?.userId || null,
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
              });
            }
          }
        }
        
        // Add new fixtures to tournament
        tournament.tournamentFixtures.push(...newFixtures);
        await tournament.save();
        console.log(`✅ Added ${newFixtures.length} new fixtures for newly added team`);
      }
    }

    // Update point table to include new team
    await updateTournamentPointTable(tournament._id);

    res.json({ message: 'Team successfully added to tournament' });
  } catch (error) {
    console.error('Add team to tournament error:', error);
    res.status(500).json({ error: error.message || 'Failed to add team to tournament' });
  }
});

// DELETE /api/tournaments/:id/subscribe - Remove team from tournament (admin only)
router.delete('/:id/subscribe', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (tournament.status === 'completed') {
      return res.status(400).json({ error: 'Cannot remove team from completed tournament' });
    }

    // Get team userId from query params or body (admin specifies which team to remove)
    const { userId } = req.query.userId ? { userId: req.query.userId } : req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID (userId) is required to remove team' });
    }

    const teamUser = await User.findById(userId);
    if (!teamUser) {
      return res.status(404).json({ error: 'Team user not found' });
    }

    if (!tournament.isUserSubscribed(teamUser._id)) {
      return res.status(400).json({ error: 'Team is not subscribed to this tournament' });
    }

    await tournament.unsubscribeUser(teamUser._id);

    // Remove fixtures involving the removed team (only if not completed)
    if (tournament.tournamentFixtures && tournament.tournamentFixtures.length > 0) {
      const teamName = teamUser.teamName || teamUser.name;
      const initialLength = tournament.tournamentFixtures.length;
      
      // Remove fixtures where this team is involved and match is not completed
      tournament.tournamentFixtures = tournament.tournamentFixtures.filter(fixture => {
        // Keep fixtures that are completed (have winner)
        if (fixture.winner) return true;
        // Remove fixtures involving the removed team
        return fixture.team1 !== teamName && fixture.team2 !== teamName;
      });
      
      const removedCount = initialLength - tournament.tournamentFixtures.length;
      if (removedCount > 0) {
        await tournament.save();
        console.log(`✅ Removed ${removedCount} fixtures involving removed team: ${teamName}`);
      }
    }

    // Update point table to remove the team
    await updateTournamentPointTable(tournament._id);

    res.json({ message: 'Team successfully removed from tournament' });
  } catch (error) {
    console.error('Remove team from tournament error:', error);
    res.status(500).json({ error: error.message || 'Failed to remove team from tournament' });
  }
});

// DELETE /api/tournaments/:id/teams/:userId - Remove team from tournament (admin only)
router.delete('/:id/teams/:userId', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const teamUser = await User.findById(req.params.userId);
    if (!teamUser) {
      return res.status(404).json({ error: 'Team user not found' });
    }

    await tournament.removeTeamSubscription(req.params.userId);

    // Remove fixtures involving the removed team (only if not completed)
    if (tournament.tournamentFixtures && tournament.tournamentFixtures.length > 0) {
      const teamName = teamUser.teamName || teamUser.name;
      const initialLength = tournament.tournamentFixtures.length;
      
      // Remove fixtures where this team is involved and match is not completed
      tournament.tournamentFixtures = tournament.tournamentFixtures.filter(fixture => {
        // Keep fixtures that are completed (have winner)
        if (fixture.winner) return true;
        // Remove fixtures involving the removed team
        return fixture.team1 !== teamName && fixture.team2 !== teamName;
      });
      
      const removedCount = initialLength - tournament.tournamentFixtures.length;
      if (removedCount > 0) {
        await tournament.save();
        console.log(`✅ Removed ${removedCount} fixtures involving removed team: ${teamName}`);
      }
    }

    // Update point table to remove the team
    await updateTournamentPointTable(tournament._id);

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
    const tournament = await Tournament.findById(req.params.id)
      .populate('subscribedTeams.userId', 'teamName abbreviation');

    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Always recalculate point table to ensure it's up-to-date (especially NRR)
    // This ensures that if scores were updated, NRR will be recalculated
    await updateTournamentPointTable(tournament._id);
    
    // Reload tournament to get updated point table
    await tournament.populate('subscribedTeams.userId', 'teamName abbreviation');
    const updatedTournament = await Tournament.findById(req.params.id)
      .populate('subscribedTeams.userId', 'teamName abbreviation');
    
    // Use updated tournament data
    const tournamentToUse = updatedTournament || tournament;

    // Create a map of teamName to abbreviation
    const teamAbbreviationMap = {};
    tournamentToUse.subscribedTeams.forEach(team => {
      const teamName = team.userId?.teamName || team.teamName;
      const abbreviation = team.userId?.abbreviation || null;
      if (teamName) {
        teamAbbreviationMap[teamName] = abbreviation;
      }
    });

    // Add abbreviation to each point table entry
    const pointTableWithAbbr = tournamentToUse.pointTable.map(entry => ({
      ...entry.toObject ? entry.toObject() : entry,
      abbreviation: teamAbbreviationMap[entry.teamName] || null
    }));

    // Sort by points (desc) then by NRR (desc) then by fairness (desc)
    const sortedPointTable = pointTableWithAbbr.sort((a, b) => {
      // Priority 1: Points (descending)
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      // Priority 2: Net Run Rate (descending)
      const nrrA = a.nrr || 0;
      const nrrB = b.nrr || 0;
      if (nrrB !== nrrA) {
        return nrrB - nrrA;
      }
      // Priority 3: Fairness (descending)
      if (b.fairness !== a.fairness) {
        return b.fairness - a.fairness;
      }
      // If all equal, maintain current order
      return 0;
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

    // Get all subscribed teams with userId and teamName
    const teams = tournament.subscribedTeams.map(team => ({
      userId: team.userId?._id || team.userId,
      teamName: team.userId?.teamName || team.teamName
    }));

    if (teams.length < 2) {
      return res.status(400).json({ error: 'At least 2 teams required to generate fixtures' });
    }

    // Generate round-robin fixtures (each team plays every other team once)
    const fixtures = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const fixture = {
          team1: teams[i].teamName,
          team2: teams[j].teamName,
          team1UserId: teams[i].userId, // userId-based
          team2UserId: teams[j].userId, // userId-based
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

    const { winner, margin, team1Score, team2Score, team1Overs, team2Overs, team1Fairness, team2Fairness, mom } = req.body;

    // Validate score format: must be in "runs/wickets" format (e.g., "107/10", "150/5")
    const scoreFormatRegex = /^\d+\/\d+$/; // Matches "number/number" format
    
    if (team1Score && !scoreFormatRegex.test(team1Score.toString().trim())) {
      return res.status(400).json({ 
        error: `Team 1 score format is invalid. Expected format: runs/wickets (e.g., "107/10", "150/5"). Received: "${team1Score}"` 
      });
    }
    
    if (team2Score && !scoreFormatRegex.test(team2Score.toString().trim())) {
      return res.status(400).json({ 
        error: `Team 2 score format is invalid. Expected format: runs/wickets (e.g., "107/10", "150/5"). Received: "${team2Score}"` 
      });
    }

    // Validate required fields
    if (!team1Overs || team1Overs.toString().trim() === '') {
      return res.status(400).json({ error: 'Team 1 overs is required' });
    }
    if (!team2Overs || team2Overs.toString().trim() === '') {
      return res.status(400).json({ error: 'Team 2 overs is required' });
    }

    const oldTournamentFixtureWinner =
      tournament.tournamentFixtures[fixtureIndex].winner || null;

    // Update the fixture in the array
    if (winner !== undefined) tournament.tournamentFixtures[fixtureIndex].winner = winner;
    if (margin !== undefined) tournament.tournamentFixtures[fixtureIndex].margin = margin;
    if (team1Score !== undefined) tournament.tournamentFixtures[fixtureIndex].team1Score = team1Score;
    if (team2Score !== undefined) tournament.tournamentFixtures[fixtureIndex].team2Score = team2Score;
    tournament.tournamentFixtures[fixtureIndex].team1Overs = team1Overs.trim();
    tournament.tournamentFixtures[fixtureIndex].team2Overs = team2Overs.trim();
    if (team1Fairness !== undefined) tournament.tournamentFixtures[fixtureIndex].team1Fairness = team1Fairness;
    if (team2Fairness !== undefined) tournament.tournamentFixtures[fixtureIndex].team2Fairness = team2Fairness;
    if (mom !== undefined) {
      // Only name is mandatory, score and wickets are optional
      tournament.tournamentFixtures[fixtureIndex].mom = {
        name: mom.name || null,
        score: mom.score !== undefined ? mom.score : null,
        wickets: mom.wickets !== undefined ? mom.wickets : null
      };
    }

    // Check if this is a knockout fixture (semi-final or final) BEFORE saving
    const currentFixture = tournament.tournamentFixtures[fixtureIndex];
    
    const roundRobinCount = expectedRoundRobinFixtureCount(tournament);
    
    // Check if it's a knockout fixture by:
    // 1. Has placeholder text ("Winner of" or "Top ")
    // 2. OR it's after the round-robin fixtures (index >= roundRobinCount)
    const hasPlaceholder = currentFixture.team1?.includes('Winner of') || 
                          currentFixture.team1?.includes('Top ') ||
                          currentFixture.team2?.includes('Winner of') || 
                          currentFixture.team2?.includes('Top ');
    const isAfterRoundRobin = fixtureIndex >= roundRobinCount;
    const isKnockoutFixture = hasPlaceholder || isAfterRoundRobin;
    
    console.log(`🔍 Fixture Update Debug:`, {
      fixtureIndex,
      totalFixtures: tournament.tournamentFixtures.length,
      team1: currentFixture.team1,
      team2: currentFixture.team2,
      winner,
      hasPlaceholder,
      isAfterRoundRobin,
      isKnockoutFixture,
      roundRobinCount
    });
    
    // Save the tournament first
    await tournament.save();

    const fxAfterSave = tournament.tournamentFixtures[fixtureIndex];
    const twNow = fxAfterSave.winner;
    const shouldBumpCareer =
      twNow &&
      (!oldTournamentFixtureWinner || oldTournamentFixtureWinner !== twNow);
    if (shouldBumpCareer) {
      applyCareerLeagueResult({
        team1: fxAfterSave.team1,
        team2: fxAfterSave.team2,
        newWinnerName: twNow,
        oldWinnerName: oldTournamentFixtureWinner || null,
      }).catch((err) => console.error('Career counters (tournament):', err));
    }

    // Auto-update point table ONLY for round-robin fixtures (NOT for semi-finals or finals)
    // Knockout matches don't affect the point table
    if (!isKnockoutFixture && (winner || team1Score !== undefined || team2Score !== undefined || team1Overs !== undefined || team2Overs !== undefined)) {
      await updateTournamentPointTable(tournament._id);
    }
    
    // Handle knockout fixture logic (semi-finals and finals)
    if (isKnockoutFixture && (winner || team1Score !== undefined || team2Score !== undefined || team1Overs !== undefined || team2Overs !== undefined)) {
      // ONLY update tournament winner when updating KNOCKOUT fixtures (semi-final or final)
      // DO NOT update winner for round-robin (Super 8) fixtures
      
      // If it's NOT a knockout fixture, NEVER update tournament winner
      if (!isKnockoutFixture) {
        // This is a round-robin fixture - do NOT update tournament winner
        return res.json({ 
          message: 'Fixture updated successfully',
          fixture: tournament.tournamentFixtures[fixtureIndex]
        });
      }
      
      // Only proceed if it's a knockout fixture
      // Check if this is the FINAL match (not semi-final)
      const isFinalMatch = (() => {
        // PRIMARY METHOD: Check if it's the LAST fixture in the tournament
        // For 8 teams: 28 round-robin + 2 semi-finals + 1 final = 31 fixtures (indices 0-30)
        // The final is ALWAYS at the last index, regardless of team names
        const isLastFixture = fixtureIndex === tournament.tournamentFixtures.length - 1;
        
        if (isLastFixture && winner) {
          console.log(`✅ Final match detected: Last fixture (index ${fixtureIndex} of ${tournament.tournamentFixtures.length - 1})`);
          return true;
        }
        
        // Method 2: Check if this is the actual final placeholder (Winner of Semi-Final 1 vs Winner of Semi-Final 2)
        const isActualFinalPlaceholder = (currentFixture.team1 === 'Winner of Semi-Final 1' && 
                                         currentFixture.team2 === 'Winner of Semi-Final 2') ||
                                        (currentFixture.team1 === 'Winner of Semi-Final 2' && 
                                         currentFixture.team2 === 'Winner of Semi-Final 1');
        
        if (isActualFinalPlaceholder && winner) {
          console.log(`✅ Final match detected: Final placeholder`);
          return true;
        }
        
        // Method 3: Check if it's the last knockout fixture
        // Get all knockout fixtures (those with placeholders OR after round-robin)
        const knockoutFixtures = tournament.tournamentFixtures.slice(roundRobinCount);
        const isLastKnockout = fixtureIndex >= roundRobinCount && 
                              (fixtureIndex - roundRobinCount) === knockoutFixtures.length - 1;
        
        if (isLastKnockout && winner) {
          console.log(`✅ Final match detected: Last knockout fixture`);
          return true;
        }
        
        // Method 4: Check if it's a semi-final (semi-finals have "Top 1", "Top 2", etc. but NOT "Winner of")
        const isSemiFinal = !currentFixture.team1?.includes('Winner of') && 
                           !currentFixture.team2?.includes('Winner of') &&
                           (currentFixture.team1?.includes('Top ') || currentFixture.team2?.includes('Top '));
        
        if (isSemiFinal) {
          console.log(`ℹ️  Semi-final detected (not final)`);
          return false; // Semi-finals are NOT the final
        }
        
        // Method 5: Check if it has "Winner of" and is in the final fixtures list
        const finalFixtures = tournament.tournamentFixtures.filter(f => 
          f.team1?.includes('Winner of') || f.team2?.includes('Winner of')
        );
        
        const isInFinalFixtures = finalFixtures.some(f => 
          f.team1 === currentFixture.team1 && f.team2 === currentFixture.team2
        );
        
        // If it's in final fixtures and has a winner, it's the final
        if (isInFinalFixtures && winner) {
          console.log(`✅ Final match detected: In final fixtures list`);
          return true;
        }
        
        return false;
      })();
      
      // ONLY update tournament winner when the FINAL match (not semi-final) is updated
      console.log(`🔍 Final Match Detection:`, {
        isFinalMatch,
        winner,
        fixtureIndex,
        totalFixtures: tournament.tournamentFixtures.length,
        isLastFixture: fixtureIndex === tournament.tournamentFixtures.length - 1,
        team1: currentFixture.team1,
        team2: currentFixture.team2
      });
      
      if (isFinalMatch && winner) {
        const completionDate = new Date();
        const winnerTeam = tournament.subscribedTeams.find(t => 
          t.teamName === winner
        );
        
        if (!winnerTeam) {
          console.error(`❌ Winner team "${winner}" not found in subscribed teams:`, 
            tournament.subscribedTeams.map(t => t.teamName));
        }
        
        // Update tournament winner from final match result (even if already set, allows re-setting)
        // This ensures the tournament winner always matches the final match winner
        tournament.winner = {
          teamName: winner,
          teamImage: winnerTeam?.teamImage || null,
          wonAt: completionDate
        };
        tournament.status = 'completed';
        tournament.endDate = completionDate;
        await tournament.save();
        console.log(`✅ Tournament ${tournament.name} completed! Winner: ${winner}, End date updated to: ${completionDate.toISOString()}`);
      } else if (!isFinalMatch && isKnockoutFixture) {
        // This is a semi-final or other knockout fixture (not final) - don't update tournament winner
        console.log(`ℹ️  Knockout fixture updated (not final) - tournament winner not updated`);
      } else if (!isFinalMatch && !isKnockoutFixture) {
        console.log(`ℹ️  Round-robin fixture updated - tournament winner not updated`);
      } else if (isFinalMatch && !winner) {
        console.log(`⚠️  Final match detected but no winner specified`);
      }
      
      // Auto-update final fixture when semi-finals complete (only for knockout fixtures)
      if (isKnockoutFixture && winner) {
        // Check if this is a semi-final that was just updated
        // Semi-finals are the first 2 knockout fixtures (after round-robin)
        // They have actual team names (not "Winner of" or "Top ")
        const isFinalPlaceholder = (currentFixture.team1 === 'Winner of Semi-Final 1' && 
                                   currentFixture.team2 === 'Winner of Semi-Final 2') ||
                                  (currentFixture.team1 === 'Winner of Semi-Final 2' && 
                                   currentFixture.team2 === 'Winner of Semi-Final 1');
        
        // If it's not the final placeholder, it's likely a semi-final
        const isSemiFinal = !isFinalPlaceholder;
        
        if (isSemiFinal) {
          // Reload tournament to get latest state after the current update
          let updatedTournament = await Tournament.findById(req.params.id);
          if (!updatedTournament) {
            console.error('❌ Tournament not found after reload');
            return res.json({ message: 'Fixture updated successfully', fixture: tournament.tournamentFixtures[fixtureIndex] });
          }
          
          // Find the final fixture placeholder
          const finalIndex = updatedTournament.tournamentFixtures.findIndex(f => 
            (f.team1 === 'Winner of Semi-Final 1' && f.team2 === 'Winner of Semi-Final 2') ||
            (f.team1 === 'Winner of Semi-Final 2' && f.team2 === 'Winner of Semi-Final 1')
          );
          
          if (finalIndex !== -1) {
            // Semi-finals are the 2 fixtures before the final
            // So if final is at index 30, semi-finals are at index 28 and 29
            const semiFinal1Index = finalIndex - 2;
            const semiFinal2Index = finalIndex - 1;
            
            if (semiFinal1Index >= 0 && semiFinal2Index >= 0) {
              const semiFinal1 = updatedTournament.tournamentFixtures[semiFinal1Index];
              const semiFinal2 = updatedTournament.tournamentFixtures[semiFinal2Index];
              const finalFixture = updatedTournament.tournamentFixtures[finalIndex];

              const getUserIdFromTeamName = (teamName) => {
                const want = teamName ? String(teamName).trim() : '';
                const subscribedTeam = updatedTournament.subscribedTeams.find(
                  (team) => String(team.teamName || '').trim() === want
                );
                return subscribedTeam?.userId || null;
              };

              let changed = false;
              // Fill whichever final slot still shows the placeholder (supports normal and swapped sides)
              if (semiFinal1.winner) {
                if (finalFixture.team1 === 'Winner of Semi-Final 1') {
                  finalFixture.team1 = semiFinal1.winner;
                  finalFixture.team1UserId = getUserIdFromTeamName(semiFinal1.winner);
                  changed = true;
                } else if (finalFixture.team2 === 'Winner of Semi-Final 1') {
                  finalFixture.team2 = semiFinal1.winner;
                  finalFixture.team2UserId = getUserIdFromTeamName(semiFinal1.winner);
                  changed = true;
                }
              }
              if (semiFinal2.winner) {
                if (finalFixture.team2 === 'Winner of Semi-Final 2') {
                  finalFixture.team2 = semiFinal2.winner;
                  finalFixture.team2UserId = getUserIdFromTeamName(semiFinal2.winner);
                  changed = true;
                } else if (finalFixture.team1 === 'Winner of Semi-Final 2') {
                  finalFixture.team1 = semiFinal2.winner;
                  finalFixture.team1UserId = getUserIdFromTeamName(semiFinal2.winner);
                  changed = true;
                }
              }

              if (changed) {
                await updatedTournament.save();
                tournament = updatedTournament;
                console.log(
                  `✅ Final matchup updated from semis → ${finalFixture.team1} vs ${finalFixture.team2}`
                );
              } else {
                console.log(
                  `ℹ️ Semis: SF1 winner ${semiFinal1.winner || '—'}, SF2 winner ${
                    semiFinal2.winner || '—'
                  } — final slot(s) still waiting`
                );
              }
            }
          }
        }
      }
    }

    res.json({ message: 'Fixture updated successfully', fixture: tournament.tournamentFixtures[fixtureIndex] });
  } catch (error) {
    console.error('Update tournament fixture error:', error);
    res.status(500).json({ error: 'Failed to update tournament fixture' });
  }
});

// POST /api/tournaments/:id/reset-winner - Reset tournament winner (admin only)
router.post('/:id/reset-winner', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    // Reset winner field
    tournament.winner = {
      teamName: null,
      teamImage: null,
      wonAt: null
    };
    
    // Reset status to 'running' if it was 'completed'
    if (tournament.status === 'completed') {
      tournament.status = 'running';
    }

    await tournament.save();

    console.log(`✅ Reset winner for tournament: ${tournament.name}`);
    res.json({ 
      message: 'Tournament winner reset successfully',
      tournament: {
        _id: tournament._id,
        name: tournament.name,
        winner: tournament.winner,
        status: tournament.status
      }
    });
  } catch (error) {
    console.error('Reset tournament winner error:', error);
    res.status(500).json({ error: 'Failed to reset tournament winner' });
  }
});

// POST /api/tournaments/:id/sync-winner-from-final - Sync tournament winner from final match fixture (admin only)
router.post('/:id/sync-winner-from-final', isAdmin, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (!tournament.tournamentFixtures || tournament.tournamentFixtures.length === 0) {
      return res.status(400).json({ error: 'No fixtures found in tournament' });
    }

    // Find the final match - it's the last fixture in the tournament
    // For 8 teams: 28 round-robin + 2 semi-finals + 1 final = 31 fixtures (index 30)
    const finalFixtureIndex = tournament.tournamentFixtures.length - 1;
    const finalFixture = tournament.tournamentFixtures[finalFixtureIndex];

    if (!finalFixture) {
      return res.status(404).json({ error: 'Final fixture not found' });
    }

    // Check if final fixture has a winner
    if (!finalFixture.winner) {
      return res.status(400).json({ 
        error: 'Final match does not have a winner yet',
        finalFixture: {
          team1: finalFixture.team1,
          team2: finalFixture.team2,
          winner: finalFixture.winner
        }
      });
    }

    const winner = finalFixture.winner;
    const winnerTeam = tournament.subscribedTeams.find(t => 
      t.teamName === winner
    );

    if (!winnerTeam) {
      return res.status(400).json({ 
        error: `Winner team "${winner}" not found in tournament subscribed teams`,
        availableTeams: tournament.subscribedTeams.map(t => t.teamName)
      });
    }

    // Update tournament winner from final match
    const completionDate = new Date();
    tournament.winner = {
      teamName: winner,
      teamImage: winnerTeam.teamImage || null,
      wonAt: completionDate
    };
    tournament.status = 'completed';
    tournament.endDate = completionDate;

    await tournament.save();

    console.log(`✅ Synced tournament winner from final match: ${winner}`);
    res.json({ 
      message: 'Tournament winner synced successfully from final match',
      tournament: {
        _id: tournament._id,
        name: tournament.name,
        winner: tournament.winner,
        status: tournament.status
      },
      finalFixture: {
        team1: finalFixture.team1,
        team2: finalFixture.team2,
        winner: finalFixture.winner
      }
    });
  } catch (error) {
    console.error('Sync tournament winner from final error:', error);
    res.status(500).json({ error: 'Failed to sync tournament winner from final match' });
  }
});

// POST /api/tournaments/world-cup/initialize - Initialize World Cup tournament with top 8 teams
router.post('/world-cup/initialize', isAdmin, async (req, res) => {
  try {
    // Check if World Cup mode is enabled
    const settings = await AppSettings.findOne().lean();
    if (!settings?.worldCupMode) {
      return res.status(400).json({ error: 'World Cup mode is not enabled. Please enable it from admin panel first.' });
    }

    // Get top 8 teams from point table
    const allTeams = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: "NA" },
      isAdmin: false,
      isActive: true
    })
      .select('_id teamName points matchesPlayed fairnessPoint teamImage')
      .lean();
    
    // Sort exactly like point table
    const sortedTeams = allTeams.sort((a, b) => {
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
    }).slice(0, 8);

    if (sortedTeams.length < 8) {
      return res.status(400).json({ error: 'Need at least 8 teams to initialize World Cup tournament' });
    }

    // Check if all top 8 teams have completed required games
    const allTeamsCompletedGames = sortedTeams.every(team => (team.matchesPlayed || 0) >= 13);

      if (!allTeamsCompletedGames) {
        const incompleteTeams = sortedTeams.filter(team => (team.matchesPlayed || 0) < 13);
        return res.status(400).json({
          error: 'All top 8 teams must complete 13 matches before initializing World Cup tournament',
        incompleteTeams: incompleteTeams.map(team => ({
          teamName: team.teamName,
          matchesPlayed: team.matchesPlayed || 0
        }))
      });
    }

    // Check for existing World Cup tournaments and find the next number
    const existingWorldCups = await Tournament.find({ 
      name: { $regex: /^World Cup \d+$/ }
    }).sort({ name: -1 });
    
    let worldCupNumber = 1;
    if (existingWorldCups.length > 0) {
      // Extract number from the latest World Cup (e.g., "World Cup 3" -> 3)
      const latestMatch = existingWorldCups[0].name.match(/World Cup (\d+)/);
      if (latestMatch) {
        worldCupNumber = parseInt(latestMatch[1]) + 1;
      } else {
        // If pattern doesn't match, count existing ones
        worldCupNumber = existingWorldCups.length + 1;
      }
    }
    
    const worldCupName = `World Cup ${worldCupNumber}`;

    // Get admin user for createdBy
    const adminUser = await User.findOne({ isAdmin: true });
    if (!adminUser) {
      return res.status(500).json({ error: 'No admin user found' });
    }

    // Create World Cup tournament
    const tournament = new Tournament({
      name: worldCupName,
      description: 'Top 8 teams play round-robin, then top 4 play semi-finals and finals',
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      maxSlots: 8,
      status: 'running',
      createdBy: adminUser._id,
      subscribedTeams: sortedTeams.map(team => ({
        userId: team._id,
        teamName: team.teamName,
        teamImage: team.teamImage || null
      }))
    });

    await tournament.save();

    // Generate round-robin fixtures (28 matches: 8 * 7 / 2)
    const fixtures = [];
    for (let i = 0; i < sortedTeams.length; i++) {
      for (let j = i + 1; j < sortedTeams.length; j++) {
        fixtures.push({
          team1: sortedTeams[i].teamName,
          team2: sortedTeams[j].teamName,
          team1UserId: sortedTeams[i]._id, // userId-based
          team2UserId: sortedTeams[j]._id, // userId-based
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
        });
      }
    }

    tournament.tournamentFixtures = fixtures;
    await tournament.save();

    // Initialize point table
    await updateTournamentPointTable(tournament._id);

    res.status(201).json({
      message: 'World Cup tournament initialized successfully',
      tournament: {
        _id: tournament._id,
        id: tournament._id,
        name: tournament.name,
        teamsCount: sortedTeams.length,
        roundRobinFixtures: fixtures.length
      }
    });
  } catch (error) {
    console.error('Initialize World Cup tournament error:', error);
    res.status(500).json({ error: 'Failed to initialize World Cup tournament' });
  }
});

// GET /api/tournaments/:id/round-robin-status - Check if round-robin is complete
router.get('/:id/round-robin-status', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const rrExpected = expectedRoundRobinFixtureCount(tournament);
    const allFx = tournament.tournamentFixtures || [];
    const roundRobinFixtures =
      rrExpected > 0 ? allFx.slice(0, Math.min(rrExpected, allFx.length)) : [];

    const completedRoundRobin = roundRobinFixtures.filter((f) => f.winner).length;
    const allComplete =
      rrExpected > 0 &&
      roundRobinFixtures.length === rrExpected &&
      completedRoundRobin === rrExpected;

    const hasKnockout = tournamentHasKnockoutStage(tournament);
    const n = tournament.subscribedTeams?.length || 0;
    const gamesPerTeamRequired = n >= 2 ? n - 1 : 0;
    const minTeamsForKnockoutBracket = 4;
    const enoughTeamsForKnockout = n >= minTeamsForKnockoutBracket;

    res.json({
      totalRoundRobin: roundRobinFixtures.length,
      totalRoundRobinExpected: rrExpected,
      completedRoundRobin,
      allComplete,
      hasKnockout,
      gamesPerTeamRequired,
      minTeamsForKnockoutBracket,
      enoughTeamsForKnockout,
      canGenerateKnockout:
        allComplete &&
        !hasKnockout &&
        rrExpected > 0 &&
        enoughTeamsForKnockout,
    });
  } catch (error) {
    console.error('Get round-robin status error:', error);
    res.status(500).json({ error: 'Failed to get round-robin status' });
  }
});

// POST /api/tournaments/:id/generate-knockout - Generate semi-finals and finals after round-robin (admin only)
router.post('/:id/generate-knockout', isAdmin, async (req, res) => {
  try {
    let tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    const hasKnockoutFixtures = tournamentHasKnockoutStage(tournament);
    if (hasKnockoutFixtures) {
      return res.status(400).json({ error: 'Knockout fixtures already generated' });
    }

    const rrExpected = expectedRoundRobinFixtureCount(tournament);
    const roundRobinFixtures = tournament.tournamentFixtures.slice(
      0,
      Math.min(rrExpected, tournament.tournamentFixtures.length)
    );

    const allRoundRobinComplete =
      rrExpected > 0 &&
      roundRobinFixtures.length === rrExpected &&
      roundRobinFixtures.every((f) => f.winner);
    if (!allRoundRobinComplete) {
      return res
        .status(400)
        .json({ error: 'Every team must finish all round-robin games before knockout (top 4 from the table).' });
    }

    const subscribedCount = tournament.subscribedTeams?.length || 0;
    if (subscribedCount < 4) {
      return res.status(400).json({
        error: 'Knockout needs at least 4 subscribed teams (semis are 1st vs 4th and 2nd vs 3rd on the table).',
      });
    }

    // Update point table first
    await updateTournamentPointTable(tournament._id);

    // Reload tournament to get latest version after point table update
    tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ error: 'Tournament not found after point table update' });
    }

    // Check if point table exists and has teams
    if (!tournament.pointTable || tournament.pointTable.length === 0) {
      return res.status(400).json({ error: 'Point table is empty. Please ensure all round-robin matches are completed and point table is updated.' });
    }

    // Get top 4 teams from point table (sorted by points desc, then NRR desc, then fairness desc)
    const sortedPointTable = [...tournament.pointTable].sort((a, b) => {
      // Priority 1: Points (descending)
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      // Priority 2: Net Run Rate (descending)
      const nrrA = a.nrr || 0;
      const nrrB = b.nrr || 0;
      if (nrrB !== nrrA) {
        return nrrB - nrrA;
      }
      // Priority 3: Fairness (descending)
      if (b.fairness !== a.fairness) {
        return b.fairness - a.fairness;
      }
      // If all equal, maintain current order
      return 0;
    });

    // De-duplicate by team name (legacy / bad data could list the same team twice)
    const seenNames = new Set();
    const uniqueByTeam = [];
    for (const row of sortedPointTable) {
      const key = row.teamName ? String(row.teamName).trim() : '';
      if (!key || seenNames.has(key)) continue;
      seenNames.add(key);
      uniqueByTeam.push(row);
    }

    const top4 = uniqueByTeam.slice(0, 4);
    if (top4.length < 4) {
      return res.status(400).json({ error: 'Need at least 4 teams in point table to generate knockout fixtures' });
    }

    // Find userIds for top 4 teams from subscribedTeams
    const getUserIdFromTeamName = (teamName) => {
      const want = teamName ? String(teamName).trim() : '';
      const subscribedTeam = tournament.subscribedTeams.find(
        (team) => String(team.teamName || '').trim() === want
      );
      return subscribedTeam?.userId || null;
    };

    // Add semi-finals: Top 1 vs Top 4, Top 2 vs Top 3
    const top1UserId = getUserIdFromTeamName(top4[0].teamName);
    const top4UserId = getUserIdFromTeamName(top4[3].teamName);
    const top2UserId = getUserIdFromTeamName(top4[1].teamName);
    const top3UserId = getUserIdFromTeamName(top4[2].teamName);

    // Prepare knockout fixtures
    const knockoutFixtures = [
      {
      team1: top4[0].teamName, // Top 1
      team2: top4[3].teamName, // Top 4
        team1UserId: top1UserId,
        team2UserId: top4UserId,
      winner: null,
      margin: null,
      team1Score: null,
      team2Score: null,
        team1Overs: null,
        team2Overs: null,
      team1Fairness: 0,
      team2Fairness: 0,
      mom: { name: null, score: null, wickets: null },
      createdAt: new Date()
      },
      {
      team1: top4[1].teamName, // Top 2
      team2: top4[2].teamName, // Top 3
        team1UserId: top2UserId,
        team2UserId: top3UserId,
      winner: null,
      margin: null,
      team1Score: null,
      team2Score: null,
        team1Overs: null,
        team2Overs: null,
      team1Fairness: 0,
      team2Fairness: 0,
      mom: { name: null, score: null, wickets: null },
      createdAt: new Date()
      },
      {
      team1: 'Winner of Semi-Final 1',
      team2: 'Winner of Semi-Final 2',
        team1UserId: null,
        team2UserId: null,
      winner: null,
      margin: null,
      team1Score: null,
      team2Score: null,
        team1Overs: null,
        team2Overs: null,
      team1Fairness: 0,
      team2Fairness: 0,
      mom: { name: null, score: null, wickets: null },
      createdAt: new Date()
      }
    ];

    // Use findByIdAndUpdate to atomically add fixtures (avoids version conflicts)
    const updatedTournament = await Tournament.findByIdAndUpdate(
      req.params.id,
      { $push: { tournamentFixtures: { $each: knockoutFixtures } } },
      { new: true }
    );

    if (!updatedTournament) {
      return res.status(404).json({ error: 'Tournament not found when saving knockout fixtures' });
    }

    res.json({
      message: 'Knockout fixtures generated successfully',
      semiFinals: 2,
      final: 1,
      top4: top4.map(t => ({ teamName: t.teamName, points: t.points, fairness: t.fairness }))
    });
  } catch (error) {
    console.error('Generate knockout fixtures error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({ 
      error: 'Failed to generate knockout fixtures',
      details: error.message || 'Unknown error'
    });
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

    // Calculate NRR for each team from tournament fixtures only (Super 8 matches)
    Object.keys(pointTable).forEach(teamName => {
      const nrr = calculateTournamentNRR(tournament.tournamentFixtures, teamName);
      pointTable[teamName].nrr = nrr;
      // Debug logging for first team to help diagnose NRR issues
      if (Object.keys(pointTable)[0] === teamName) {
        const completedFixtures = tournament.tournamentFixtures.filter(f => f.winner);
        const normalizeTeamName = (name) => name ? name.trim().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
        const normalizedTeamName = normalizeTeamName(teamName);
        const teamFixtures = completedFixtures.filter(f => {
          const normTeam1 = normalizeTeamName(f.team1);
          const normTeam2 = normalizeTeamName(f.team2);
          return normTeam1 === normalizedTeamName || normTeam2 === normalizedTeamName;
        });
        console.log(`📊 NRR calculation for ${teamName}:`, {
          nrr,
          completedFixtures: completedFixtures.length,
          teamFixtures: teamFixtures.length,
          sampleScores: teamFixtures.slice(0, 3).map(f => ({
            team1: f.team1,
            team2: f.team2,
            team1Score: f.team1Score,
            team2Score: f.team2Score,
            team1Overs: f.team1Overs,
            team2Overs: f.team2Overs
          }))
        });
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
/** For maintenance scripts (e.g. repair knockout) — same logic as POST generate-knockout preamble. */
module.exports.updateTournamentPointTable = updateTournamentPointTable;
