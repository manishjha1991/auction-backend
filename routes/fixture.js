const express = require('express');
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
const { cacheConfig } = require('../utils/cache');
const { saveFixtureResult } = require('../utils/fixtureSaveService');

const router = express.Router();



router.get('/', async (req, res) => {
  // 🚀 PERFORMANCE: Check cache first (2 minute cache for fixtures)
  const mode = req.query.mode || 'normal';
  const cacheKey = `fixtures:${mode}`;
  const cached = cacheConfig.medium.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {
    
    // 1) Fetch teams (users) that have a valid teamName, are active, tournament ready, participating, and are not admin.
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const teams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isTournamentReady: true, // Only include users who are tournament ready
      isParticipating: { $ne: false }, // Exclude non-participating teams
      isAdmin: { $ne: true } // Exclude admin teams
    })
      .populate('boughtPlayers')
      .select('_id teamName teamImage boughtPlayers group')
      .lean(); 
      // Include _id so we can reference owner user IDs for OCR dropdowns

    // 2) Fetch all active fixtures (which store team1/team2 as strings)
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const existingFixtures = await Fixture.find({ isActive: true }).lean();

    // Deduplicate existing fixtures - batch delete duplicates (no winner) in one call
    const uniqueFixtureMap = new Set();
    const duplicateIdsToDelete = [];
    for (const fixture of existingFixtures) {
      let sortedKey;
      if (fixture.team1UserId && fixture.team2UserId) {
        sortedKey = [fixture.team1UserId.toString(), fixture.team2UserId.toString()].sort().join('-');
      } else {
        sortedKey = [fixture.team1, fixture.team2].sort().join('-');
      }
      if (uniqueFixtureMap.has(sortedKey) && !fixture.winner) {
        duplicateIdsToDelete.push(fixture._id);
      } else {
        uniqueFixtureMap.add(sortedKey);
      }
    }
    if (duplicateIdsToDelete.length > 0) {
      await Fixture.deleteMany({ _id: { $in: duplicateIdsToDelete } });
    }

    // 3) Re-fetch cleaned active fixtures
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const cleanedFixtures = await Fixture.find({ isActive: true }).lean();

    // 4) Separate teams by groups
    const groupA = teams.filter(team => team.group === 'A');
    const groupB = teams.filter(team => team.group === 'B');
    const ungroupedTeams = teams.filter(team => !team.group || team.group === null);

    // 5) Build a set of fixture keys from existing fixtures
    // Check by userId if available, otherwise fall back to teamName
    const fixtureMap = new Set();
    cleanedFixtures.forEach((f) => {
      if (f.team1UserId && f.team2UserId) {
        // Use userId for duplicate detection (preferred)
        const userIdKey = [f.team1UserId.toString(), f.team2UserId.toString()].sort().join('-');
        fixtureMap.add(userIdKey);
      } else {
        // Fall back to teamName for backward compatibility
        const teamNameKey = [f.team1, f.team2].sort().join('-');
        fixtureMap.add(teamNameKey);
      }
    });

    // 6) Generate new fixtures based on mode
    const newFixtures = [];

    if (mode === 'groups') {
      // GROUP STAGE: Generate fixtures within each group
      // Group A fixtures
      if (groupA.length > 1) {
        for (let i = 0; i < groupA.length; i++) {
          for (let j = i + 1; j < groupA.length; j++) {
            const t1 = groupA[i].teamName;
            const t2 = groupA[j].teamName;
            const t1Id = groupA[i]._id;
            const t2Id = groupA[j]._id;
            // Use userId for duplicate detection (preferred)
            const fixtureKey = [t1Id.toString(), t2Id.toString()].sort().join('-');
            // Also check teamName for backward compatibility
            const teamNameKey = [t1, t2].sort().join('-');

            if (!fixtureMap.has(fixtureKey) && !fixtureMap.has(teamNameKey)) {
              newFixtures.push({ 
                team1: t1, 
                team2: t2,
                team1UserId: t1Id, // userId-based
                team2UserId: t2Id, // userId-based
                group: 'A',
                matchType: 'group'
              });
              fixtureMap.add(fixtureKey);
            }
          }
        }
      }

      // Group B fixtures
      if (groupB.length > 1) {
        for (let i = 0; i < groupB.length; i++) {
          for (let j = i + 1; j < groupB.length; j++) {
            const t1 = groupB[i].teamName;
            const t2 = groupB[j].teamName;
            const t1Id = groupB[i]._id;
            const t2Id = groupB[j]._id;
            // Use userId for duplicate detection (preferred)
            const fixtureKey = [t1Id.toString(), t2Id.toString()].sort().join('-');
            // Also check teamName for backward compatibility
            const teamNameKey = [t1, t2].sort().join('-');

            if (!fixtureMap.has(fixtureKey) && !fixtureMap.has(teamNameKey)) {
              newFixtures.push({ 
                team1: t1, 
                team2: t2,
                team1UserId: t1Id, // userId-based
                team2UserId: t2Id, // userId-based
                group: 'B',
                matchType: 'group'
              });
              fixtureMap.add(fixtureKey);
            }
          }
        }
      }

      // If there are ungrouped teams, create normal fixtures for them
      if (ungroupedTeams.length > 1) {
        for (let i = 0; i < ungroupedTeams.length; i++) {
          for (let j = i + 1; j < ungroupedTeams.length; j++) {
            const t1 = ungroupedTeams[i].teamName;
            const t2 = ungroupedTeams[j].teamName;
            const t1Id = ungroupedTeams[i]._id;
            const t2Id = ungroupedTeams[j]._id;
            // Use userId for duplicate detection (preferred)
            const fixtureKey = [t1Id.toString(), t2Id.toString()].sort().join('-');
            // Also check teamName for backward compatibility
            const teamNameKey = [t1, t2].sort().join('-');

            if (!fixtureMap.has(fixtureKey) && !fixtureMap.has(teamNameKey)) {
              newFixtures.push({ 
                team1: t1, 
                team2: t2,
                team1UserId: t1Id, // userId-based
                team2UserId: t2Id, // userId-based
                group: null,
                matchType: 'normal'
              });
              fixtureMap.add(fixtureKey);
            }
          }
        }
      }
    } else {
      // NORMAL MODE: Generate fixtures for all teams (everyone plays everyone)
      if (process.env.NODE_ENV !== 'production') console.log(`🏏 Normal fixtures: ${teams.length} teams`);
      
      // Calculate expected number of fixtures (n choose 2)
      const expectedFixtures = (teams.length * (teams.length - 1)) / 2;
      if (process.env.NODE_ENV !== 'production') console.log(`📊 Expected: ${expectedFixtures} fixtures`);
      
      // Generate fixtures for ALL teams regardless of group assignment
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const t1 = teams[i].teamName;
          const t2 = teams[j].teamName;
          const t1Id = teams[i]._id;
          const t2Id = teams[j]._id;
          // Use userId for duplicate detection (preferred)
          const fixtureKey = [t1Id.toString(), t2Id.toString()].sort().join('-');
          // Also check teamName for backward compatibility
          const teamNameKey = [t1, t2].sort().join('-');

          if (!fixtureMap.has(fixtureKey) && !fixtureMap.has(teamNameKey)) {
            newFixtures.push({ 
              team1: t1, 
              team2: t2,
              team1UserId: t1Id, // userId-based
              team2UserId: t2Id, // userId-based
              group: null,
              matchType: 'normal'
            });
            fixtureMap.add(fixtureKey);
          }
        }
      }
    }

    // 7) Insert any new fixtures
    if (newFixtures.length > 0) {
      await Fixture.insertMany(newFixtures);
      if (process.env.NODE_ENV !== 'production' && newFixtures.length) console.log(`✅ Created ${newFixtures.length} fixtures`);
    }
    
    // 7.5) Log total fixture count
    const totalActiveFixtures = await Fixture.countDocuments({ isActive: true });
    if (process.env.NODE_ENV !== 'production') console.log(`📊 Total active fixtures: ${totalActiveFixtures}`);

    // 8) Fetch *all* active fixtures sorted by createdAt
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const allFixtures = await Fixture.find({ isActive: true })
      .sort({ createdAt: 1 })
      .lean();

    // Filter out fixtures involving non-participating teams
    // Use userId for matching (more reliable than team name, which can change)
    const participatingTeamIds = new Set(teams.map(t => t._id.toString()));
    const participatingTeamNames = new Set(teams.map(t => t.teamName));
    
    const filteredFixtures = allFixtures.filter(fixture => {
      // Try userId matching first (most reliable)
      if (fixture.team1UserId && fixture.team2UserId) {
        const team1Id = fixture.team1UserId.toString();
        const team2Id = fixture.team2UserId.toString();
        return participatingTeamIds.has(team1Id) && participatingTeamIds.has(team2Id);
      }
      
      // Fallback to team name matching (for old fixtures without userId)
      const team1Participating = participatingTeamNames.has(fixture.team1);
      const team2Participating = participatingTeamNames.has(fixture.team2);
      return team1Participating && team2Participating;
    });

    // 9) Enhance each fixture with user/team details
    const enhancedFixtures = filteredFixtures.map((fixture) => {
      // Find team1 by userId first (handles name changes), fallback to name matching
      let team1Details = null;
      if (fixture.team1UserId) {
        team1Details = teams.find((t) => t._id.toString() === fixture.team1UserId.toString());
      }
      if (!team1Details) {
        team1Details = teams.find((t) => t.teamName === fixture.team1);
      }
      team1Details = team1Details || {};

      // Find team2 by userId first (handles name changes), fallback to name matching
      let team2Details = null;
      if (fixture.team2UserId) {
        team2Details = teams.find((t) => t._id.toString() === fixture.team2UserId.toString());
      }
      if (!team2Details) {
        team2Details = teams.find((t) => t.teamName === fixture.team2);
      }
      team2Details = team2Details || {};

      // IMPORTANT: Use CURRENT team name from User document, not old fixture name
      const ownerTeam1 = {
        userId: team1Details._id || null,
        teamName: team1Details.teamName || fixture.team1 || 'Unknown',
        teamImage: team1Details.teamImage || null,
        players: team1Details.boughtPlayers || [],
      };

      const ownerTeam2 = {
        userId: team2Details._id || null,
        teamName: team2Details.teamName || fixture.team2 || 'Unknown',
        teamImage: team2Details.teamImage || null,
        players: team2Details.boughtPlayers || [],
      };

      // Note: Since we use .lean(), fixture is a plain object, not a Mongoose document
      // So we spread fixture directly (not fixture._doc)
      return {
        ...fixture,
        // OVERRIDE with CURRENT team names (not old stored names)
        team1: team1Details.teamName || fixture.team1,
        team2: team2Details.teamName || fixture.team2,

        // Add extra details
        team1Details: {
          ...ownerTeam1,
        },
        team2Details: {
          ...ownerTeam2,
        },
      };
    });

    // 🚀 PERFORMANCE: Cache the response (2 minute cache)
    cacheConfig.medium.set(cacheKey, enhancedFixtures);
    if (process.env.NODE_ENV !== 'production') console.log(`💾 Fixtures cached: ${mode}`);

    // Return final list
    res.status(200).json(enhancedFixtures);
  } catch (error) {
    console.error('Error fetching fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch fixtures.' });
  }
});

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  try {
    // Try to get userId from header first, then from body
    const userId = req.headers['user-id'] || req.body.userId;
    if (!userId || userId === 'undefined' || userId === 'null') {
      console.error('❌ Admin check failed: User ID missing in headers or body');
      console.error('❌ Headers:', JSON.stringify(req.headers, null, 2));
      console.error('❌ Body keys:', Object.keys(req.body || {}));
      return res.status(401).json({ 
        error: 'User ID required',
        message: 'Please provide user-id header or userId in request body'
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      console.error(`❌ Admin check failed: User not found with ID: ${userId}`);
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.isAdmin) {
      console.error(`❌ Admin check failed: User ${userId} is not admin`);
      return res.status(403).json({ error: 'Only admin can perform this action' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Authentication error:', error);
    res.status(500).json({ 
      error: 'Server error',
      message: error.message 
    });
  }
};

router.post('/save', isAdmin, async (req, res) => {
  try {
    if (process.env.NODE_ENV !== 'production') console.log('📥 Fixture save:', req.body._id);
    const result = await saveFixtureResult(req.body, { req });
    res.status(200).json(result);
  } catch (error) {
    console.error('❌ Error saving fixture:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Request body:', JSON.stringify(req.body, null, 2));

    const errorMessage = error.message || 'Failed to save fixture result';
    const errorDetails = process.env.NODE_ENV === 'development' ? error.stack : undefined;

    if (error.name === 'ValidationError') {
      const validationErrors = Object.keys(error.errors || {}).map((key) => ({
        field: key,
        message: error.errors[key].message,
      }));
      return res.status(400).json({
        error: 'Validation error',
        message: errorMessage,
        validationErrors,
        ...(errorDetails && { details: errorDetails }),
      });
    }

    const status = /not participating/i.test(errorMessage)
      ? 403
      : /required|invalid/i.test(errorMessage)
      ? 400
      : 500;
    res.status(status).json({
      error: 'Failed to save fixture result',
      message: errorMessage,
      ...(errorDetails && { details: errorDetails }),
    });
  }
});

// Admin: apply points for a completed fixture when stats were never written (e.g. OCR name mismatch).
router.post('/reapply-points/:id', isAdmin, async (req, res) => {
  try {
    const fixture = await Fixture.findById(req.params.id);
    if (!fixture) return res.status(404).json({ error: 'Fixture not found' });
    if (!fixture.winner) {
      return res.status(400).json({ error: 'This fixture has no winner yet.' });
    }
    if (fixture.pointsTableApplied) {
      return res.status(400).json({
        error: 'Points were already applied for this fixture. Use Save to edit the result instead.',
      });
    }

    const result = await saveFixtureResult(
      {
        _id: fixture._id,
        team1: fixture.team1,
        team2: fixture.team2,
        team1UserId: fixture.team1UserId,
        team2UserId: fixture.team2UserId,
        winner: fixture.winner,
        margin: fixture.margin,
        team1Score: fixture.team1Score,
        team2Score: fixture.team2Score,
        team1Overs: fixture.team1Overs,
        team2Overs: fixture.team2Overs,
        mom: fixture.mom,
        team1Fairness: fixture.team1Fairness,
        team2Fairness: fixture.team2Fairness,
        group: fixture.group,
        matchType: fixture.matchType,
      },
      { req }
    );

    res.status(200).json({
      message: 'Points table updated for this fixture.',
      ...result,
    });
  } catch (error) {
    console.error('Reapply points error:', error);
    res.status(500).json({ error: error.message || 'Failed to reapply points' });
  }
});

// Get fixtures filtered by group or match type
router.get('/filter', async (req, res) => {
  try {
    const { group, matchType } = req.query;
    
    let query = { isActive: true };
    
    if (group) {
      query.group = group;
    }
    
    if (matchType) {
      query.matchType = matchType;
    }
    
    // Get participating teams
    const participatingTeams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isParticipating: { $ne: false },
      isAdmin: { $ne: true }
    }).select('_id teamName').lean();
    
    const participatingTeamIds = new Set(participatingTeams.map(t => t._id.toString()));
    const participatingTeamNames = new Set(participatingTeams.map(t => t.teamName));
    
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const allFixtures = await Fixture.find(query).sort({ createdAt: 1 }).lean();
    
    // Filter out fixtures with non-participating teams (use userId matching)
    const fixtures = allFixtures.filter(fixture => {
      // Try userId matching first (handles team name changes)
      if (fixture.team1UserId && fixture.team2UserId) {
        return participatingTeamIds.has(fixture.team1UserId.toString()) && 
               participatingTeamIds.has(fixture.team2UserId.toString());
      }
      // Fallback to team name matching
      return participatingTeamNames.has(fixture.team1) && participatingTeamNames.has(fixture.team2);
    });
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching filtered fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch filtered fixtures.' });
  }
});

// Get group stage fixtures only
router.get('/group-stage', async (req, res) => {
  try {
    // Get participating teams
    const participatingTeams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isParticipating: { $ne: false },
      isAdmin: { $ne: true }
    }).select('_id teamName').lean();
    
    const participatingTeamIds = new Set(participatingTeams.map(t => t._id.toString()));
    const participatingTeamNames = new Set(participatingTeams.map(t => t.teamName));
    
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const allFixtures = await Fixture.find({ 
      isActive: true, 
      matchType: 'group' 
    }).sort({ createdAt: 1 }).lean();
    
    // Filter out fixtures with non-participating teams (use userId matching)
    const fixtures = allFixtures.filter(fixture => {
      // Try userId matching first (handles team name changes)
      if (fixture.team1UserId && fixture.team2UserId) {
        return participatingTeamIds.has(fixture.team1UserId.toString()) && 
               participatingTeamIds.has(fixture.team2UserId.toString());
      }
      // Fallback to team name matching
      return participatingTeamNames.has(fixture.team1) && participatingTeamNames.has(fixture.team2);
    });
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching group stage fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch group stage fixtures.' });
  }
});

// Get normal fixtures only
router.get('/normal', async (req, res) => {
  try {
    // Get participating teams
    const participatingTeams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isParticipating: { $ne: false },
      isAdmin: { $ne: true }
    }).select('_id teamName').lean();
    
    const participatingTeamIds = new Set(participatingTeams.map(t => t._id.toString()));
    const participatingTeamNames = new Set(participatingTeams.map(t => t.teamName));
    
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const allFixtures = await Fixture.find({ 
      isActive: true, 
      matchType: 'normal' 
    }).sort({ createdAt: 1 }).lean();
    
    // Filter out fixtures with non-participating teams (use userId matching)
    const fixtures = allFixtures.filter(fixture => {
      // Try userId matching first (handles team name changes)
      if (fixture.team1UserId && fixture.team2UserId) {
        return participatingTeamIds.has(fixture.team1UserId.toString()) && 
               participatingTeamIds.has(fixture.team2UserId.toString());
      }
      // Fallback to team name matching
      return participatingTeamNames.has(fixture.team1) && participatingTeamNames.has(fixture.team2);
    });
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching normal fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch normal fixtures.' });
  }
});

module.exports = router;

