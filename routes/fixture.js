const express = require('express');
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const headToHeadModule = require('./headToHead');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
const { cacheConfig, invalidateCache } = require('../utils/cache');
const { emitPointsTableUpdated } = require('../utils/emitPointsTableUpdate');
const { applyCareerLeagueResult } = require('../utils/careerUserCounters');

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
    
    // 1) Fetch teams (users) that have a valid teamName, are active, tournament ready, and are not admin.
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const teams = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isTournamentReady: true, // Only include users who are tournament ready
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

    // 9) Enhance each fixture with user/team details, matched by teamName
    const enhancedFixtures = allFixtures.map((fixture) => {
      // Try to find user details by matching user.teamName === fixture.team1
      const team1Details = teams.find(
        (t) => t.teamName === fixture.team1
      ) || {};

      // Same for team2
      const team2Details = teams.find(
        (t) => t.teamName === fixture.team2
      ) || {};

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
        // Keep the original team1/team2 in place 
        team1: fixture.team1,
        team2: fixture.team2,

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
  let oldWinnerBeforeSave = null;
  try {
    if (process.env.NODE_ENV !== 'production') console.log('📥 Fixture save:', req.body._id);
    
    const {
      _id,
      team1,
      team2,
      team1UserId,
      team2UserId,
      winner,
      margin,
      mom,
      team1Score,
      team2Score,
      team1Overs,
      team2Overs,
      team1Fairness,
      team2Fairness,
      group,
      matchType,
    } = req.body;

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

    // Validate required fields - overs are mandatory (coerce to string in case client sends number)
    const team1OversStr = String(team1Overs || '').trim();
    const team2OversStr = String(team2Overs || '').trim();
    if (!team1OversStr) {
      return res.status(400).json({ error: 'Team 1 overs is required' });
    }
    if (!team2OversStr) {
      return res.status(400).json({ error: 'Team 2 overs is required' });
    }

    // Find fixture by _id first if provided, then by userId if available, otherwise by teamName
    let fixture = null;
    if (_id) {
      try {
        // Note: Don't use .lean() here because we need to modify and save this fixture
        fixture = await Fixture.findById(_id);
        if (!fixture && process.env.NODE_ENV !== 'production') console.log(`⚠️ Fixture not found: ${_id}`);
      } catch (idError) {
        console.error(`❌ Error finding fixture by _id ${_id}:`, idError.message);
        // Continue to try other methods
      }
    }
    
    // If not found by _id, try to find by team1UserId/team2UserId or teamName
    if (!fixture && team1 && team2) {
      // Try to find by userId first (preferred) - use provided userIds or look them up
      let userId1 = team1UserId || null;
      let userId2 = team2UserId || null;
      
      // If userIds not provided, look them up by teamName
      if (!userId1 || !userId2) {
        // 🚀 PERFORMANCE: Use .lean() for faster queries (only for lookup, not for fixture)
        const team1UserLookup = await User.findOne({ teamName: team1, isActive: true }).lean();
        const team2UserLookup = await User.findOne({ teamName: team2, isActive: true }).lean();
        userId1 = userId1 || (team1UserLookup ? team1UserLookup._id : null);
        userId2 = userId2 || (team2UserLookup ? team2UserLookup._id : null);
      }
      
      if (userId1 && userId2) {
        // Note: Don't use .lean() here because we need to modify and save this fixture
        fixture = await Fixture.findOne({
          $or: [
            { team1UserId: userId1, team2UserId: userId2 },
            { team1UserId: userId2, team2UserId: userId1 }
          ],
          isActive: true
        });
      }
      
      // Fall back to teamName if not found by userId
      if (!fixture) {
        // Note: Don't use .lean() here because we need to modify and save this fixture
        fixture = await Fixture.findOne({ team1, team2, isActive: true });
      }
      // Note: fixture is already a Mongoose document (not lean) so we can save it directly
    }

    // If no existing fixture, create a new one
    if (!fixture) {
      // Get userIds for teams (use provided userIds or look them up)
      const userId1 = team1UserId || null;
      const userId2 = team2UserId || null;
      
      let finalUserId1 = userId1;
      let finalUserId2 = userId2;
      
      if (!finalUserId1 && team1) {
        const team1User = await User.findOne({ teamName: team1, isActive: true });
        finalUserId1 = team1User?._id || null;
      }
      
      if (!finalUserId2 && team2) {
        const team2User = await User.findOne({ teamName: team2, isActive: true });
        finalUserId2 = team2User?._id || null;
      }
      
      fixture = new Fixture({
        team1,
        team2,
        team1UserId: finalUserId1, // userId-based
        team2UserId: finalUserId2, // userId-based
        winner,
        margin,
        mom: mom ? {
          name: mom.name || null, // Only name is mandatory
          score: mom.score !== undefined ? mom.score : null, // Optional
          wickets: mom.wickets !== undefined ? mom.wickets : null // Optional
        } : null,
        team1Score,
        team2Score,
        team1Overs: team1OversStr, // Mandatory
        team2Overs: team2OversStr, // Mandatory
        team1Fairness,
        team2Fairness,
        group: group || null,
        matchType: matchType || 'normal',
      });
    } else {
      // Otherwise, update existing fixture
      oldWinnerBeforeSave = fixture.winner;
      if (winner !== undefined) fixture.winner = winner;
      if (margin !== undefined) fixture.margin = margin;
      if (mom !== undefined) {
        // Only name is mandatory, score and wickets are optional
        fixture.mom = {
          name: mom.name || null,
          score: mom.score !== undefined ? mom.score : null,
          wickets: mom.wickets !== undefined ? mom.wickets : null
        };
      }
      if (team1Score !== undefined) fixture.team1Score = team1Score;
      if (team2Score !== undefined) fixture.team2Score = team2Score;
      // Overs are mandatory - always update
      fixture.team1Overs = team1OversStr;
      fixture.team2Overs = team2OversStr;
      if (team1Fairness !== undefined) fixture.team1Fairness = team1Fairness;
      if (team2Fairness !== undefined) fixture.team2Fairness = team2Fairness;
      // Update group and matchType if provided
      if (group !== undefined) fixture.group = group;
      if (matchType !== undefined) fixture.matchType = matchType;
      
      // Update userIds if provided in request or missing (for backward compatibility)
      // Note: These queries need to return Mongoose documents (not lean) because we modify them
      if (team1UserId && team1UserId !== fixture.team1UserId) {
        fixture.team1UserId = team1UserId;
      }
      if (team2UserId && team2UserId !== fixture.team2UserId) {
        fixture.team2UserId = team2UserId;
      }
      
      if (!fixture.team1UserId || !fixture.team2UserId) {
        const team1User = await User.findOne({ teamName: fixture.team1, isActive: true });
        const team2User = await User.findOne({ teamName: fixture.team2, isActive: true });
        if (team1User && !fixture.team1UserId) fixture.team1UserId = team1User._id;
        if (team2User && !fixture.team2UserId) fixture.team2UserId = team2User._id;
      }
      
      // Update winnerUserId if winner is set
      if (fixture.winner && !fixture.winnerUserId) {
        const winnerUser = await User.findOne({ teamName: fixture.winner, isActive: true });
        if (winnerUser) fixture.winnerUserId = winnerUser._id;
      }
    }

    // Validate required fields before saving
    if (!fixture.team1 || !fixture.team2) {
      return res.status(400).json({ 
        error: 'Missing required fields: team1 and team2 are required' 
      });
    }

    await fixture.save();
    
    // 🚀 PERFORMANCE: Invalidate fixtures cache when fixture is saved
    invalidateCache('fixtures:');

    applyCareerLeagueResult({
      team1: fixture.team1,
      team2: fixture.team2,
      newWinnerName: fixture.winner,
      oldWinnerName: oldWinnerBeforeSave,
    }).catch((err) => console.error('Career counters:', err));
    
    // Automatically update points for both teams after fixture is saved
    if (fixture.winner) {
      try {
        // Find both teams by teamName
        const team1User = await User.findOne({ teamName: fixture.team1 });
        const team2User = await User.findOne({ teamName: fixture.team2 });
        
        if (team1User && team2User) {
          // Update team1: winner gets +2 points, loser gets +0 points
          if (fixture.winner === fixture.team1) {
            team1User.points = (team1User.points || 0) + 2;
            team2User.points = (team2User.points || 0) + 0;
          } else {
            team1User.points = (team1User.points || 0) + 0;
            team2User.points = (team2User.points || 0) + 2;
          }
          
          // Add fairness points to both teams
          team1User.fairnessPoint = (team1User.fairnessPoint || 0) + (fixture.team1Fairness || 0);
          team2User.fairnessPoint = (team2User.fairnessPoint || 0) + (fixture.team2Fairness || 0);
          
          // Increment matches played for both teams
          team1User.matchesPlayed = (team1User.matchesPlayed || 0) + 1;
          team2User.matchesPlayed = (team2User.matchesPlayed || 0) + 1;
          
          // Save both users
          await Promise.all([team1User.save(), team2User.save()]);
          
          if (process.env.NODE_ENV !== 'production') console.log(`✅ Points updated: ${fixture.team1} vs ${fixture.team2}`);
        }
        // Head-to-head: if winner changed on update, mark unsynced, revert old winner, then re-sync
        if (oldWinnerBeforeSave && oldWinnerBeforeSave !== fixture.winner && headToHeadModule.revertAndResyncForRecord) {
          Fixture.updateOne({ _id: fixture._id }, { $set: { headToHeadSynced: false } })
            .then(() => headToHeadModule.revertAndResyncForRecord(fixture.team1, fixture.team2, oldWinnerBeforeSave))
            .catch((err) => console.error('Head-to-head sync:', err));
        } else if (headToHeadModule.syncHeadToHead) {
          headToHeadModule.syncHeadToHead().catch((err) => console.error('Head-to-head sync:', err));
        }

      } catch (pointsError) {
        console.error('Error updating points:', pointsError);
        // Don't fail the fixture save if points update fails
      }
    }
    
    // Convert fixture to plain object for response (handle both Mongoose doc and plain object)
    const fixtureResponse = fixture.toObject ? fixture.toObject() : fixture;

    emitPointsTableUpdated(req, { reason: 'fixture_saved' });
    
    res.status(200).json({
      message: 'Fixture result saved successfully! Points updated automatically.',
      fixture: fixtureResponse,
    });
  } catch (error) {
    console.error('❌ Error saving fixture:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Request body:', JSON.stringify(req.body, null, 2));
    
    // Return detailed error message for debugging
    const errorMessage = error.message || 'Failed to save fixture result';
    const errorDetails = process.env.NODE_ENV === 'development' ? error.stack : undefined;
    
    // Check for validation errors
    if (error.name === 'ValidationError') {
      const validationErrors = Object.keys(error.errors || {}).map(key => ({
        field: key,
        message: error.errors[key].message
      }));
      return res.status(400).json({ 
        error: 'Validation error',
        message: errorMessage,
        validationErrors,
        ...(errorDetails && { details: errorDetails })
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to save fixture result',
      message: errorMessage,
      ...(errorDetails && { details: errorDetails })
    });
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
    
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const fixtures = await Fixture.find(query).sort({ createdAt: 1 }).lean();
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching filtered fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch filtered fixtures.' });
  }
});

// Get group stage fixtures only
router.get('/group-stage', async (req, res) => {
  try {
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const fixtures = await Fixture.find({ 
      isActive: true, 
      matchType: 'group' 
    }).sort({ createdAt: 1 }).lean();
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching group stage fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch group stage fixtures.' });
  }
});

// Get normal fixtures only
router.get('/normal', async (req, res) => {
  try {
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const fixtures = await Fixture.find({ 
      isActive: true, 
      matchType: 'normal' 
    }).sort({ createdAt: 1 }).lean();
    
    res.status(200).json(fixtures);
  } catch (error) {
    console.error('Error fetching normal fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch normal fixtures.' });
  }
});

module.exports = router;

