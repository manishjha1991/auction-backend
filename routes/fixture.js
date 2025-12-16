const express = require('express');
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');

const router = express.Router();



router.get('/', async (req, res) => {
  try {
    // Get mode from query parameter
    const mode = req.query.mode || 'normal';
    console.log(`🏏 Fixture generation mode: ${mode}`);
    
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

    // Deduplicate existing fixtures - check by userId if available, otherwise by teamName
    const uniqueFixtureMap = new Set();
    for (const fixture of existingFixtures) {
      // Prefer userId for duplicate detection, fall back to teamName
      let sortedKey;
      if (fixture.team1UserId && fixture.team2UserId) {
        sortedKey = [fixture.team1UserId.toString(), fixture.team2UserId.toString()].sort().join('-');
      } else {
        sortedKey = [fixture.team1, fixture.team2].sort().join('-');
      }

      if (uniqueFixtureMap.has(sortedKey)) {
        // If we already have this pair, 
        // and there's no winner => remove the duplicate
        if (!fixture.winner) {
          await Fixture.deleteOne({ _id: fixture._id });
        }
      } else {
        uniqueFixtureMap.add(sortedKey);
      }

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
      console.log('🏆 Generating GROUP STAGE fixtures...');
      
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
      console.log('🏏 Generating NORMAL fixtures...');
      console.log(`📊 Found ${teams.length} teams for normal mode fixture generation`);
      
      // Calculate expected number of fixtures (n choose 2)
      const expectedFixtures = (teams.length * (teams.length - 1)) / 2;
      console.log(`📊 Expected fixtures for ${teams.length} teams: ${expectedFixtures} (every team plays each other once)`);
      
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
      console.log(`✅ Created ${newFixtures.length} new fixtures:`, newFixtures.map(f => `${f.team1} vs ${f.team2} (${f.matchType}${f.group ? ` - Group ${f.group}` : ''})`));
    }
    
    // 7.5) Log total fixture count
    const totalActiveFixtures = await Fixture.countDocuments({ isActive: true });
    console.log(`📊 Total active fixtures in database: ${totalActiveFixtures}`);

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

    // Return final list
    res.status(200).json(enhancedFixtures);
  } catch (error) {
    console.error('Error fetching fixtures:', error);
    res.status(500).json({ message: 'Failed to fetch fixtures.' });
  }
});

router.post('/save', async (req, res) => {
  try {
    const {
      team1,
      team2,
      winner,
      margin,
      mom,
      team1Score,
      team2Score,
      team1Fairness,
      team2Fairness,
      group,
      matchType,
    } = req.body;

    // Find fixture by userId if available, otherwise by teamName
    let fixture = null;
    if (team1 && team2) {
      // Try to find userIds for teams
      // 🚀 PERFORMANCE: Use .lean() for faster queries
      const team1User = await User.findOne({ teamName: team1, isActive: true }).lean();
      const team2User = await User.findOne({ teamName: team2, isActive: true }).lean();
      
      if (team1User && team2User) {
        // Try to find by userId first (preferred)
        // Note: Don't use .lean() here because we need to modify and save this fixture
        fixture = await Fixture.findOne({
          $or: [
            { team1UserId: team1User._id, team2UserId: team2User._id },
            { team1UserId: team2User._id, team2UserId: team1User._id }
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
      // Get userIds for teams
      const team1User = await User.findOne({ teamName: team1, isActive: true });
      const team2User = await User.findOne({ teamName: team2, isActive: true });
      
      fixture = new Fixture({
        team1,
        team2,
        team1UserId: team1User?._id || null, // userId-based
        team2UserId: team2User?._id || null, // userId-based
        winner,
        margin,
        mom,
        team1Score,
        team2Score,
        team1Fairness,
        team2Fairness,
        group: group || null,
        matchType: matchType || 'normal',
      });
    } else {
      // Otherwise, update existing fixture
      fixture.winner = winner;
      fixture.margin = margin;
      fixture.mom = mom;
      fixture.team1Score = team1Score;
      fixture.team2Score = team2Score;
      fixture.team1Fairness = team1Fairness;
      fixture.team2Fairness = team2Fairness;
      // Update group and matchType if provided
      if (group !== undefined) fixture.group = group;
      if (matchType !== undefined) fixture.matchType = matchType;
      
      // Update userIds if missing (for backward compatibility)
      // Note: These queries need to return Mongoose documents (not lean) because we modify them
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

    await fixture.save();
    
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
          
          console.log(`✅ Points updated: ${fixture.team1} (${fixture.winner === fixture.team1 ? 'WIN +2' : 'LOSS +0'}) vs ${fixture.team2} (${fixture.winner === fixture.team2 ? 'WIN +2' : 'LOSS +0'})`);
        }
      } catch (pointsError) {
        console.error('Error updating points:', pointsError);
        // Don't fail the fixture save if points update fails
      }
    }
    
    res.status(200).json({
      message: 'Fixture result saved successfully! Points updated automatically.',
      fixture,
    });
  } catch (error) {
    console.error('Error saving fixture:', error);
    res.status(500).json({ message: 'Failed to save fixture result.' });
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

