const express = require('express');
const router = express.Router();
const PlayoffFixture = require('../models/PlayoffFixture');
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const AppSettings = require('../models/AppSettings');
const Fixture = require('../models/Fixture');
const { applyPlayoffFixtureResult } = require('../utils/playoffSaveService');

// Helper function to parse score string and extract runs
const parseRuns = (scoreString) => {
  if (!scoreString) {
    return 0;
  }

  const scoreStr = String(scoreString).trim();
  if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' ||
      scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
    return 0;
  }

  const match = scoreStr.match(/^(\d+)/);
  if (match) {
    const runs = parseInt(match[1], 10);
    return isNaN(runs) ? 0 : runs;
  }

  const num = parseFloat(scoreStr);
  return isNaN(num) ? 0 : Math.floor(num);
};

// Helper function to parse wickets from score string
const parseWickets = (scoreString) => {
  if (!scoreString) {
    return 0;
  }

  const scoreStr = String(scoreString).trim();
  if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' ||
      scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
    return 0;
  }

  const slashMatch = scoreStr.match(/\/(\d+)/);
  if (slashMatch) {
    const wickets = parseInt(slashMatch[1], 10);
    if (!isNaN(wickets) && wickets >= 0 && wickets <= 10) {
      return wickets;
    }
  }

  const hyphenMatch = scoreStr.match(/-(\d+)/);
  if (hyphenMatch) {
    const wickets = parseInt(hyphenMatch[1], 10);
    if (!isNaN(wickets) && wickets >= 0 && wickets <= 10) {
      return wickets;
    }
  }

  return 0;
};

// Helper function to parse overs string and convert to decimal
const parseOvers = (oversString) => {
  if (!oversString) {
    return null;
  }

  const oversStr = String(oversString).trim();
  if (oversStr === 'null' || oversStr === 'TBD' || oversStr === 'NA' ||
      oversStr === '' || oversStr === 'undefined' || oversStr.toLowerCase() === 'null') {
    return null;
  }

  const decimalMatch = oversStr.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch) {
    const overs = parseInt(decimalMatch[1], 10);
    const balls = parseInt(decimalMatch[2], 10);
    if (!isNaN(overs) && !isNaN(balls) && balls >= 0 && balls <= 5) {
      return overs + (balls / 6);
    }
  }

  const wholeMatch = oversStr.match(/^(\d+)$/);
  if (wholeMatch) {
    const overs = parseInt(wholeMatch[1], 10);
    if (!isNaN(overs)) {
      return overs;
    }
  }

  const num = parseFloat(oversStr);
  if (!isNaN(num) && num >= 0) {
    return num;
  }

  return null;
};

// Calculate Net Run Rate (NRR) for a team following ICC rules
const calculateNRR = (fixtures, teamName, userId) => {
  const DEFAULT_OVERS = 20;
  let totalRunsScored = 0;
  let totalRunsConceded = 0;
  let totalOversFaced = 0;
  let totalOversBowled = 0;
  let matchesCount = 0;

  const userIdStr = userId ? userId.toString() : null;

  fixtures.forEach((fixture) => {
    if (!fixture.winner) {
      return;
    }

    const score1 = fixture.team1Score;
    const score2 = fixture.team2Score;

    const team1Runs = parseRuns(score1);
    const team2Runs = parseRuns(score2);
    if (team1Runs === 0 && team2Runs === 0) {
      return;
    }

    const team1Wickets = parseWickets(score1);
    const team2Wickets = parseWickets(score2);

    let team1OversActual = parseOvers(fixture.team1Overs);
    let team2OversActual = parseOvers(fixture.team2Overs);

    if (team1OversActual === null) {
      team1OversActual = DEFAULT_OVERS;
    }
    if (team2OversActual === null) {
      team2OversActual = DEFAULT_OVERS;
    }

    const team1OversFaced = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;
    const team2OversFaced = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    const team1OversBowled = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    const team2OversBowled = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;

    const team1UserIdStr = fixture.team1UserId ?
      (fixture.team1UserId.toString ? fixture.team1UserId.toString() : String(fixture.team1UserId)) : null;
    const team2UserIdStr = fixture.team2UserId ?
      (fixture.team2UserId.toString ? fixture.team2UserId.toString() : String(fixture.team2UserId)) : null;

    let isTeam1 = false;
    let isTeam2 = false;

    if (userIdStr) {
      if (team1UserIdStr && team1UserIdStr === userIdStr) {
        isTeam1 = true;
      } else if (team2UserIdStr && team2UserIdStr === userIdStr) {
        isTeam2 = true;
      }
    }

    if (!isTeam1 && !isTeam2) {
      if (fixture.team1 && fixture.team1.trim().toLowerCase() === teamName.trim().toLowerCase()) {
        isTeam1 = true;
      } else if (fixture.team2 && fixture.team2.trim().toLowerCase() === teamName.trim().toLowerCase()) {
        isTeam2 = true;
      }
    }

    if (!isTeam1 && !isTeam2) {
      return;
    }

    if (isTeam1) {
      totalRunsScored += team1Runs;
      totalRunsConceded += team2Runs;
      totalOversFaced += team1OversFaced;
      totalOversBowled += team1OversBowled;
    } else {
      totalRunsScored += team2Runs;
      totalRunsConceded += team1Runs;
      totalOversFaced += team2OversFaced;
      totalOversBowled += team2OversBowled;
    }

    matchesCount++;
  });

  if (matchesCount === 0) {
    return 0;
  }

  const runsScoredPerOver = totalOversFaced > 0 ? totalRunsScored / totalOversFaced : 0;
  const runsConcededPerOver = totalOversBowled > 0 ? totalRunsConceded / totalOversBowled : 0;
  const nrr = runsScoredPerOver - runsConcededPerOver;

  return parseFloat(nrr.toFixed(3));
};

// Get all playoff fixtures
router.get('/', async (req, res) => {
  try {
    // Check if World Cup mode is enabled
    const settings = await AppSettings.findOne().lean();
    const isWorldCupMode = settings?.worldCupMode === true;
    
    let playoffFixtures = [];
    
    if (isWorldCupMode) {
      // If World Cup mode is enabled, fetch World Cup tournament fixtures
      const worldCupTournament = await Tournament.findOne({
        name: { $regex: /^World Cup \d+$/ },
        status: 'running'
      }).lean();
      
      if (worldCupTournament && worldCupTournament.tournamentFixtures) {
        // Convert all tournament fixtures (round-robin + knockout) to PlayoffFixture format
        let matchIndex = 1;
        playoffFixtures = worldCupTournament.tournamentFixtures.map((fixture, index) => {
          // Determine stage based on fixture content
          let stage = 'WORLD CUP ROUND-ROBIN';
          let matchId = `WC${matchIndex}`;
          
          // Check if this is a knockout fixture
          if (fixture.team1?.includes('Top ') || fixture.team1?.includes('Winner of')) {
            if (fixture.team1?.includes('Top 1') || fixture.team1?.includes('Top 4')) {
              stage = 'WORLD CUP SEMI-FINAL 1';
              matchId = 'WCSF1';
            } else if (fixture.team1?.includes('Top 2') || fixture.team1?.includes('Top 3')) {
              stage = 'WORLD CUP SEMI-FINAL 2';
              matchId = 'WCSF2';
            } else if (fixture.team1?.includes('Winner of Semi-Final 1') || 
                       fixture.team1?.includes('Winner of WCSF1')) {
              stage = 'WORLD CUP FINAL';
              matchId = 'WCF';
            }
          } else {
            matchIndex++;
          }
          
          return {
            _id: fixture._id || `wc-${index}`,
            matchId: matchId,
            stage: stage,
            team1: fixture.team1,
            team2: fixture.team2,
            team1UserId: fixture.team1UserId,
            team2UserId: fixture.team2UserId,
            team1Score: fixture.team1Score || 'TBD',
            team2Score: fixture.team2Score || 'TBD',
            winner: fixture.winner || null,
            winnerUserId: fixture.winnerUserId || null,
            margin: fixture.margin || null,
            mom: fixture.mom || { name: null, score: null, wickets: null },
            team1Fairness: fixture.team1Fairness || 0,
            team2Fairness: fixture.team2Fairness || 0,
            description: fixture.team1?.includes('Top ') || fixture.team1?.includes('Winner of') 
              ? `${fixture.team1} vs ${fixture.team2}`
              : `${fixture.team1} vs ${fixture.team2}`,
            createdAt: fixture.createdAt || new Date()
          };
        });
        
        console.log('Fetching World Cup fixtures:', playoffFixtures.length, 'fixtures');
      } else {
        console.log('World Cup mode enabled but no running World Cup tournament found');
      }
    } else {
      // Normal mode: fetch regular playoff fixtures
      playoffFixtures = await PlayoffFixture.find().sort({ matchId: 1 }).lean();
      console.log('Fetching playoff fixtures:', playoffFixtures.map(f => `${f.matchId}: ${f.team1} vs ${f.team2}`));
    }
    
    res.json(playoffFixtures);
  } catch (error) {
    console.error('Error fetching playoff fixtures:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Initialize playoff fixtures - different logic based on mode
router.post('/initialize', async (req, res) => {
  try {
    const { mode } = req.body; // Get mode from request body
    console.log('Playoff initialization mode:', mode); // Debug log

    if (mode === 'groups') {
      // GROUPS MODE: Top 3 from each group
      // Use same filters as point table: teamName exists, not NA, isActive, not admin, participating
      const groupARaw = await User.find({ 
        teamName: { $exists: true, $ne: null, $ne: "NA" },
        group: 'A',
        isAdmin: false,
        isActive: true,
        isParticipating: { $ne: false } // Exclude non-participating teams
      })
        .select('_id teamName points matchesPlayed fairnessPoint')
        .lean();
      
      // Sort exactly like point table: points desc, fairness desc, matchesPlayed asc, teamName asc
      const groupATeams = groupARaw.sort((a, b) => {
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
      }).slice(0, 3);

      const groupBRaw = await User.find({ 
        teamName: { $exists: true, $ne: null, $ne: "NA" },
        group: 'B',
        isAdmin: false,
        isActive: true,
        isParticipating: { $ne: false } // Exclude non-participating teams
      })
        .select('_id teamName points matchesPlayed fairnessPoint')
        .lean();
      
      // Sort exactly like point table: points desc, fairness desc, matchesPlayed asc, teamName asc
      const groupBTeams = groupBRaw.sort((a, b) => {
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
      }).slice(0, 3);

      if (groupATeams.length < 3 || groupBTeams.length < 3) {
        return res.status(400).json({ 
          message: 'Need at least 3 teams in each group to initialize playoffs',
          groupA: groupATeams.length,
          groupB: groupBTeams.length
        });
      }

      // Calculate required games per group (each team plays everyone in their group once)
      const requiredGamesGroupA = groupARaw.length - 1; // Total teams in group A minus 1
      const requiredGamesGroupB = groupBRaw.length - 1; // Total teams in group B minus 1
      
      // Check if all qualifying teams have completed required matches
      const allQualifyingTeams = [...groupATeams, ...groupBTeams];
      const groupAIncomplete = groupATeams.filter(team => (team.matchesPlayed || 0) < requiredGamesGroupA);
      const groupBIncomplete = groupBTeams.filter(team => (team.matchesPlayed || 0) < requiredGamesGroupB);
      const hasIncomplete = groupAIncomplete.length > 0 || groupBIncomplete.length > 0;
      
      if (hasIncomplete) {
        return res.status(400).json({ 
          message: 'All qualifying teams must complete required matches before initializing playoffs',
          requiredGamesGroupA,
          requiredGamesGroupB,
          incompleteTeams: [
            ...groupAIncomplete.map(team => ({
              teamName: team.teamName,
              group: 'A',
              matchesPlayed: team.matchesPlayed || 0,
              required: requiredGamesGroupA
            })),
            ...groupBIncomplete.map(team => ({
              teamName: team.teamName,
              group: 'B',
              matchesPlayed: team.matchesPlayed || 0,
              required: requiredGamesGroupB
            }))
          ]
        });
      }

      // Group A: A1, A2, A3 (top 3)
      const [A1, A2, A3] = groupATeams;
      // Group B: B1, B2, B3 (top 3)
      const [B1, B2, B3] = groupBTeams;
      
      console.log('Group A teams:', groupATeams.map(t => ({ name: t.teamName, points: t.points, group: t.group })));
      console.log('Group B teams:', groupBTeams.map(t => ({ name: t.teamName, points: t.points, group: t.group })));

      // Clear existing playoff fixtures
      await PlayoffFixture.deleteMany({});

      // Create playoff fixtures according to new groups format
      const playoffFixtures = [
        {
          matchId: 'Q1',
          stage: 'QUALIFIER 1',
          team1: A2.teamName, // A2
          team2: B3.teamName, // B3
          team1UserId: A2._id, // userId-based
          team2UserId: B3._id, // userId-based
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'A2 vs B3'
        },
        {
          matchId: 'Q2',
          stage: 'QUALIFIER 2',
          team1: B2.teamName, // B2
          team2: A3.teamName, // A3
          team1UserId: B2._id, // userId-based
          team2UserId: A3._id, // userId-based
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'B2 vs A3'
        },
        {
          matchId: 'SF1',
          stage: 'SEMI-FINAL 1',
          team1: A1.teamName, // A1
          team2: 'Winner of Qualifier 1',
          team1UserId: A1._id, // userId-based
          team2UserId: null, // Will be updated when Q1 winner is determined
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'A1 vs Winner of Q1'
        },
        {
          matchId: 'SF2',
          stage: 'SEMI-FINAL 2',
          team1: B1.teamName, // B1
          team2: 'Winner of Qualifier 2',
          team1UserId: B1._id, // userId-based
          team2UserId: null, // Will be updated when Q2 winner is determined
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'B1 vs Winner of Q2'
        },
        {
          matchId: 'F',
          stage: 'FINAL',
          team1: 'Winner of Semi-Final 1',
          team2: 'Winner of Semi-Final 2',
          team1UserId: null, // Will be updated when SF1 winner is determined
          team2UserId: null, // Will be updated when SF2 winner is determined
          team1Score: 'TBD',
          team2Score: 'TBD',
          description: 'Winner of SF1 vs Winner of SF2'
        }
      ];

      await PlayoffFixture.insertMany(playoffFixtures);
      console.log('Created playoff fixtures:', playoffFixtures.map(f => `${f.matchId}: ${f.team1} vs ${f.team2}`));
      
      res.json({ 
        message: 'Playoff fixtures initialized successfully (Groups Mode)',
        format: 'Top 3 from each group qualify',
        fixtures: playoffFixtures.length
      });

    } else {
      // NORMAL MODE: Original format with top 6 overall teams
      // Use same filters and sorting as point table endpoint
      // Filter: teamName exists, not NA, isActive, not admin, participating
      const allTeams = await User.find({ 
        teamName: { $exists: true, $ne: null, $ne: "NA" },
        isAdmin: false,
        isActive: true,
        isParticipating: { $ne: false } // Exclude non-participating teams
      })
        .select('_id teamName points matchesPlayed fairnessPoint')
        .lean();

      const fixtures = await Fixture.find({
        isActive: true,
        winner: { $ne: null, $exists: true }
      })
        .select('team1 team2 team1UserId team2UserId team1Score team2Score team1Overs team2Overs winner')
        .lean();

      const teamsWithNrr = allTeams.map((team) => ({
        ...team,
        nrr: calculateNRR(fixtures, team.teamName, team._id)
      }));
      
      // Sort exactly like point table: points → NRR → fairness → matches → name
      const teams = teamsWithNrr.sort((a, b) => {
        const pointsA = a.points || 0;
        const pointsB = b.points || 0;
        if (pointsB !== pointsA) return pointsB - pointsA;

        const nrrA = a.nrr || 0;
        const nrrB = b.nrr || 0;
        if (nrrB !== nrrA) return nrrB - nrrA;

        const fairnessA = a.fairnessPoint || 0;
        const fairnessB = b.fairnessPoint || 0;
        if (fairnessB !== fairnessA) return fairnessB - fairnessA;
        
        const matchesA = a.matchesPlayed || 0;
        const matchesB = b.matchesPlayed || 0;
        if (matchesA !== matchesB) return matchesA - matchesB;
        
        const nameA = (a.teamName || '').toLowerCase();
        const nameB = (b.teamName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      }).slice(0, 6);

      if (teams.length < 6) {
        return res.status(400).json({ message: 'Need at least 6 participating teams to initialize playoffs' });
      }

      // Calculate required games based on participating teams count
      const participatingTeamsCount = allTeams.length;
      const requiredGames = participatingTeamsCount - 1; // Each team plays every other participating team once

      // Check if all top 6 teams have completed required games
      const allTeamsCompletedGames = teams.every(team => (team.matchesPlayed || 0) >= requiredGames);

      if (!allTeamsCompletedGames) {
        const incompleteTeams = teams.filter(team => (team.matchesPlayed || 0) < requiredGames);
        return res.status(400).json({
          message: `All top 6 teams must complete ${requiredGames} matches before initializing playoffs (${participatingTeamsCount} participating teams)`,
          requiredGames,
          participatingTeamsCount,
          incompleteTeams: incompleteTeams.map(team => ({
            teamName: team.teamName,
            matchesPlayed: team.matchesPlayed || 0
          }))
        });
      }

      const [team1, team2, team3, team4, team5, team6] = teams;

      // Clear existing playoff fixtures
      await PlayoffFixture.deleteMany({});

      // Create playoff fixtures according to original format
      const playoffFixtures = [
        {
          matchId: 'A',
          stage: 'ELIMINATOR ROUND',
          team1: team3.teamName,
          team2: team6.teamName,
          team1UserId: team3._id, // userId-based
          team2UserId: team6._id, // userId-based
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'B',
          stage: 'ELIMINATOR ROUND',
          team1: team4.teamName,
          team2: team5.teamName,
          team1UserId: team4._id, // userId-based
          team2UserId: team5._id, // userId-based
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'C',
          stage: 'QUALIFIER 1',
          team1: team1.teamName,
          team2: team2.teamName,
          team1UserId: team1._id, // userId-based
          team2UserId: team2._id, // userId-based
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'D',
          stage: 'ELIMINATOR 2',
          team1: 'Winner of Match A',
          team2: 'Winner of Match B',
          team1UserId: null, // Will be updated when Match A winner is determined
          team2UserId: null, // Will be updated when Match B winner is determined
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'E',
          stage: 'QUALIFIER 2',
          team1: 'Loser of Match C',
          team2: 'Winner of Match D',
          team1UserId: null, // Will be updated when Match C loser is determined
          team2UserId: null, // Will be updated when Match D winner is determined
          team1Score: 'TBD',
          team2Score: 'TBD'
        },
        {
          matchId: 'F',
          stage: 'FINALS',
          team1: 'Winner of Match C',
          team2: 'Winner of Match E',
          team1UserId: null, // Will be updated when Match C winner is determined
          team2UserId: null, // Will be updated when Match E winner is determined
          team1Score: 'TBD',
          team2Score: 'TBD'
        }
      ];

      await PlayoffFixture.insertMany(playoffFixtures);
      res.json({ 
        message: 'Playoff fixtures initialized successfully (Normal Mode)',
        format: 'Top 6 overall teams qualify',
        fixtures: playoffFixtures.length
      });
    }
  } catch (error) {
    console.error('Error initializing playoff fixtures:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update playoff fixture
router.post('/update/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const playoffFixture = await applyPlayoffFixtureResult(matchId, req.body);

    if (!playoffFixture) {
      return res.status(404).json({ message: 'Playoff fixture not found' });
    }

    res.json(playoffFixture);
  } catch (error) {
    console.error('Error updating playoff fixture:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
