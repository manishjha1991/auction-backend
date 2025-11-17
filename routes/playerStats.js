const express = require('express');
const router = express.Router();
const PlayerStats = require('../models/PlayerStats'); // Adjust the path as needed
const Player = require('../models/Player'); // Adjust the path
const User = require('../models/User'); // Adjust the path
const UserPlayer = require('../models/UserPlayer'); // Adjust the path
// Load list of players with playerId and userId

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundNumber = (value = 0, digits = 2) => Number.parseFloat((value || 0).toFixed(digits));

const summarizeRoleFocus = (player) => {
  if (!player) return 'Utility Player';
  if (player.role) return player.role;
  if (player.type) return `${player.type} pick`;
  return 'Squad Player';
};

const buildRecentHighlight = (runs, wickets) => {
  if (runs >= 50) return 'Match-winning knock';
  if (runs >= 35) return 'Anchor innings';
  if (wickets >= 4) return 'Devastating spell';
  if (wickets >= 2) return 'Key breakthroughs';
  if (runs >= 20) return 'Handy cameo';
  if (wickets === 0 && runs === 0) return 'Quiet outing';
  return 'Support contribution';
};

const computeInsightPayload = (player, ownerTeam, stats) => {
  if (!stats.length) {
    return {
      playerId: player._id,
      playerName: player.name,
      teamName: ownerTeam,
      roleFocus: summarizeRoleFocus(player),
      summary: 'No recorded performances yet. Once stats are logged, insights will appear here.',
      form: null,
      batting: null,
      bowling: null,
      recentMatches: [],
      hasStats: false,
    };
  }

  const sortedStats = [...stats].sort((a, b) => a.createdAt - b.createdAt);
  const matchCount = sortedStats.length;
  const lastFive = sortedStats.slice(-5);
  const lastThree = sortedStats.slice(-3);
  const previousThree = sortedStats.slice(-6, -3);

  const totals = sortedStats.reduce(
    (acc, stat) => {
      const runs = stat.battingStats?.runs || 0;
      const balls = stat.battingStats?.balls || 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;

      acc.battingRuns += runs;
      acc.battingBalls += balls;
      acc.wickets += wickets;
      acc.runsGiven += runsGiven;
      acc.ballsBowled += ballsBowled;

      return acc;
    },
    { battingRuns: 0, battingBalls: 0, wickets: 0, runsGiven: 0, ballsBowled: 0 }
  );

  const lastFiveTotals = lastFive.reduce(
    (acc, stat) => {
      const runs = stat.battingStats?.runs || 0;
      const balls = stat.battingStats?.balls || 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;

      acc.battingRuns += runs;
      acc.battingBalls += balls;
      acc.wickets += wickets;
      acc.runsGiven += runsGiven;
      acc.ballsBowled += ballsBowled;

      return acc;
    },
    { battingRuns: 0, battingBalls: 0, wickets: 0, runsGiven: 0, ballsBowled: 0 }
  );

  const recentAvg = lastFive.length ? lastFiveTotals.battingRuns / lastFive.length : 0;
  const recentStrikeRate =
    lastFiveTotals.battingBalls > 0
      ? (lastFiveTotals.battingRuns / lastFiveTotals.battingBalls) * 100
      : 0;

  const overallAvg = matchCount > 0 ? totals.battingRuns / matchCount : 0;
  const overallStrikeRate =
    totals.battingBalls > 0 ? (totals.battingRuns / totals.battingBalls) * 100 : 0;

  const economy =
    totals.ballsBowled > 0 ? totals.runsGiven / (totals.ballsBowled / 6 || 1) : 0;
  const bowlingStrikeRate =
    totals.wickets > 0 ? totals.ballsBowled / totals.wickets : 0;
  const recentEconomy =
    lastFiveTotals.ballsBowled > 0
      ? lastFiveTotals.runsGiven / (lastFiveTotals.ballsBowled / 6 || 1)
      : 0;

  const lastThreeAvg =
    lastThree.length > 0
      ? lastThree.reduce((sum, stat) => sum + (stat.battingStats?.runs || 0), 0) /
        lastThree.length
      : 0;
  const prevThreeAvg =
    previousThree.length > 0
      ? previousThree.reduce((sum, stat) => sum + (stat.battingStats?.runs || 0), 0) /
        previousThree.length
      : 0;

  const trendUp = lastThreeAvg >= prevThreeAvg;
  const formScore = clamp(
    Math.round(recentAvg * 1.5 + recentStrikeRate / 4 + lastFiveTotals.wickets * 6),
    12,
    98
  );

  const formOutlook = trendUp
    ? 'In rhythm – trending upward.'
    : 'Needs a spark – form tapering slightly.';
  const projection =
    formScore >= 70
      ? 'Projected to deliver an impact outing next match.'
      : 'Best deployed with support while form rebuilds.';

  const tags = [];
  if (recentStrikeRate >= 140) tags.push('Powerplay aggressor');
  if (recentAvg >= 35) tags.push('Reliable anchor');
  if (lastFiveTotals.wickets / Math.max(lastFive.length, 1) >= 1.5)
    tags.push('Strike bowler');
  if (!tags.length) tags.push('Flexible role');

  const recentMatches = lastFive
    .slice()
    .reverse()
    .map((stat, index) => {
      const runs = stat.battingStats?.runs || 0;
      const balls = stat.battingStats?.balls || 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const highlight = buildRecentHighlight(runs, wickets);
      const opponent =
        stat.opponentUserId?.teamName ||
        (stat.opponentUserId?.team ? stat.opponentUserId.team : 'Unknown Team');
      return {
        matchLabel: `Match ${matchCount - index}`,
        opponent,
        runs,
        strikeRate: balls ? roundNumber((runs / balls) * 100) : null,
        wickets,
        highlight,
        date: stat.createdAt,
      };
    });

  const summary = `${player.name} averages ${roundNumber(
    overallAvg
  )} runs (${roundNumber(overallStrikeRate)} SR) across ${matchCount} matches. Over the last ${
    lastFive.length
  } innings, they're posting ${roundNumber(
    recentAvg
  )} runs with a form score of ${formScore}. Bowling returns sit at ${roundNumber(
    totals.wickets / Math.max(matchCount, 1),
    2
  )} wickets per match with ${roundNumber(economy)} economy. ${formOutlook}`;

  return {
    playerId: player._id,
    playerName: player.name,
    teamName: ownerTeam,
    roleFocus: summarizeRoleFocus(player),
    summary,
    hasStats: true,
    form: {
      score: formScore,
      outlook: formOutlook,
      projection,
      tags,
    },
    batting: {
      average: roundNumber(overallAvg),
      strikeRate: roundNumber(overallStrikeRate),
      recentAverage: roundNumber(recentAvg),
      recentStrikeRate: roundNumber(recentStrikeRate),
    },
    bowling: {
      wicketsPerMatch: roundNumber(totals.wickets / Math.max(matchCount, 1), 2),
      economy: roundNumber(economy),
      recentEconomy: roundNumber(recentEconomy),
      strikeRate: roundNumber(bowlingStrikeRate),
    },
    recentMatches,
  };
};

const generatePlayerInsight = async (playerId) => {
  const player = await Player.findById(playerId).lean();
  if (!player) {
    return { error: 'player-not-found' };
  }

  const ownerUser = await User.findOne({ boughtPlayers: playerId })
    .select('teamName')
    .lean();

  const stats = await PlayerStats.find({ playerId })
    .populate({
      path: 'opponentUserId',
      model: User,
      select: 'teamName',
    })
    .sort({ createdAt: 1 })
    .lean();

  const insight = computeInsightPayload(
    player,
    ownerUser?.teamName || 'Free Agent',
    stats
  );

  return insight;
};

const buildComparisonRecommendation = (insightA, insightB) => {
  const battingEdge =
    (insightA.batting?.recentAverage || 0) - (insightB.batting?.recentAverage || 0);
  const bowlingEdge =
    (insightA.bowling?.wicketsPerMatch || 0) -
    (insightB.bowling?.wicketsPerMatch || 0);
  const formEdge = (insightA.form?.score || 0) - (insightB.form?.score || 0);

  if (battingEdge >= 6) {
    return `${insightA.playerName} offers stronger recent batting with ${roundNumber(
      insightA.batting?.recentAverage
    )} vs ${roundNumber(
      insightB.batting?.recentAverage
    )}. Ideal for top-order duties.`;
  }

  if (battingEdge <= -6) {
    return `${insightB.playerName} is the more reliable scorer right now, making them the safer batting pick.`;
  }

  if (bowlingEdge >= 0.6) {
    return `${insightA.playerName} provides better wicket-taking impact (${roundNumber(
      insightA.bowling?.wicketsPerMatch
    )} wickets/match).`;
  }

  if (bowlingEdge <= -0.6) {
    return `${insightB.playerName} brings superior bowling returns and control.`;
  }

  if (Math.abs(formEdge) >= 8) {
    return formEdge > 0
      ? `${insightA.playerName} carries hotter form and should be prioritized.`
      : `${insightB.playerName} carries hotter form and should be prioritized.`;
  }

  return 'Both players are performing similarly; base the decision on specific role requirements or matchup advantages.';
};

// Helper function to update cumulative stats in Player document
const updatePlayerCumulativeStats = async (playerId) => {
  try {
    // Get all stats for this player
    const allStats = await PlayerStats.find({ playerId });
    
    // Calculate cumulative stats
    let totalRuns = 0;
    let totalBalls = 0;
    let totalRunsGiven = 0;
    let totalBallsBowled = 0;
    let totalWickets = 0;
    let momCount = 0;

    allStats.forEach(stat => {
      totalRuns += stat.battingStats?.runs || 0;
      totalBalls += stat.battingStats?.balls || 0;
      totalRunsGiven += stat.bowlingStats?.runsGiven || 0;
      totalBallsBowled += stat.bowlingStats?.ballsBowled || 0;
      totalWickets += stat.bowlingStats?.wickets || 0;
      if (stat.isMom) momCount++;
    });

    // Update the Player document
    await Player.findByIdAndUpdate(playerId, {
      $set: {
        totalRuns: totalRuns,
        totalBalls: totalBalls,
        totalRunsGiven: totalRunsGiven,
        totalBallsBowled: totalBallsBowled,
        totalWickets: totalWickets,
        momCount: momCount,
        matchesPlayed: allStats.length
      }
    });

    console.log(`Updated cumulative stats for player ${playerId}:`, {
      totalRuns, totalBalls, totalRunsGiven, totalBallsBowled, totalWickets, momCount, matchesPlayed: allStats.length
    });
  } catch (error) {
    console.error('Error updating cumulative stats:', error);
  }
};

router.get('/list', async (req, res) => {
  try {
    const { userId } = req.query;

    // Check if the user exists and populate the boughtPlayers field
    const user = await User.findById(userId).populate({
      path: 'boughtPlayers',
      match: { isSold: true, isActive: true },
      select:
        '_id name type role basePrice style overallScore profilePicture isSold isActive'
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Skip if user is not tournament ready
    if (!user.isTournamentReady) {
      return res.status(403).json({ message: 'User is not tournament ready' });
    }

    const isAdmin = user.isAdmin;
    let playersToSend = [];

    if (isAdmin) {
      // Admin sees all active sold players from the Player collection
      playersToSend = await Player.find(
        { isSold: true, isActive: true },
        '_id name type role basePrice style overallScore profilePicture isSold isActive'
      );
    } else {
      // Normal user sees only the players they have bought
      playersToSend = user.boughtPlayers || [];
    }

    // Helper function to convert balls into overs (X.Y format)
    const convertBallsToOvers = (balls) => {
      const b = balls || 0;
      const overs = Math.floor(b / 6);
      const remainder = b % 6;
      return `${overs}.${remainder}`;
    };

    // Fetch match performance stats for each player
    const playersWithDetails = await Promise.all(
      playersToSend.map(async (player) => {
        // Fetch match stats for this player
        const stats = await PlayerStats.find({ playerId: player._id });

        // Calculate batting performance per match
        const battingStats = await Promise.all(
          stats.map(async (stat) => ({
            match: stat.matchName,
            runs: stat.battingStats?.runs || 0,
            balls: stat.battingStats?.balls || 0,
            mom: stat.isMom || false,
            // Lookup the opponent's team name from the User model
            against:
              (await User.findById(stat.opponentUserId).select('teamName'))
                ?.teamName || 'Unknown'
          }))
        );

        // Calculate bowling performance per match
        const bowlingStats = await Promise.all(
          stats.map(async (stat) => ({
            match: stat.matchName,
            overs: convertBallsToOvers(stat.bowlingStats?.ballsBowled),
            wickets: stat.bowlingStats?.wickets || 0,
            runs: stat.bowlingStats?.runsGiven || 0,
            mom: stat.isMom || false,
            // Lookup the opponent's team name from the User model
            against:
              (await User.findById(stat.opponentUserId).select('teamName'))
                ?.teamName || 'Unknown'
          }))
        );

        // Calculate total stats
        const totalBattingRuns = battingStats.reduce(
          (sum, match) => sum + match.runs,
          0
        );
        const totalWickets = bowlingStats.reduce(
          (sum, match) => sum + match.wickets,
          0
        );
        // 4. Update the Player document with these new totals
        await Player.findByIdAndUpdate(
          player._id,
          {
            $set: {
              totalRuns: totalBattingRuns,
              totalWickets: totalWickets
            }
          },
          { new: true } // so it returns updated doc if you need it
        );
        return {
          _id: player._id,
          name: player.name,
          type: player.type,
          role: player.role,
          team: user.teamName, // Get team name from the user document
          matchPerformance: {
            batting: battingStats,
            bowling: bowlingStats
          },
          totalStats: {
            batting: { runs: totalBattingRuns },
            bowling: { wickets: totalWickets }
          }
        };
      })
    );

    // ---------------------------
    // Create Playoff Fixtures
    // ---------------------------
    // For this example, we are simply querying the top five teams (active teams with a valid teamName).
    // Adjust the sorting field based on your ranking system.
    const playoffTeams = await User.find({
      isActive: true,
      teamName: { $exists: true, $ne: null, $ne: 'NA' }
    })
      .sort({ teamName: 1 }) // Replace with your ranking criteria if available
      .limit(5);

    let playoffFixtures = [];
    if (playoffTeams.length === 5) {
      playoffFixtures = [
        {
          matchType: 'Qualifier 1',
          team1: playoffTeams[0].teamName,
          team2: playoffTeams[1].teamName,
          // In Qualifier 1, the winner advances directly to the Final,
          // and the loser goes to Qualifier 2.
        },
        {
          matchType: 'Eliminator 1',
          team1: playoffTeams[2].teamName,
          team2: playoffTeams[3].teamName,
          // The winner of Eliminator 1 goes to Qualifier 2.
        },
        {
          matchType: 'Qualifier 2',
          team1: 'TBD (Loser of Qualifier 1)',
          team2: 'TBD (Winner of Eliminator 1)',
          // Winner advances; loser plays in Eliminator 3.
        },
        {
          matchType: 'Eliminator 3',
          team1: 'TBD (Loser of Qualifier 2)',
          team2: playoffTeams[4].teamName,
          // The winner advances to the Final.
        },
        {
          matchType: 'Final',
          team1: 'TBD (Winner Qualifier 1)',
          team2: 'TBD (Winner of Eliminator 3)',
          // The champion is decided in the Final.
        }
      ];
    }
    // ---------------------------

    res.json({ players: playersWithDetails, playoffFixtures });
  } catch (error) {
    console.error('Error fetching player list:', error);
    res.status(500).json({ message: 'Error fetching player list', error });
  }
});





// Store player stats
// routes/playerStats.js (example)
router.post('/store', async (req, res) => {
  try {
    const {
      playerId,
      opponentUserId,
      battingStats,
      bowlingStats,
      wicketsTaken,
      isMom,
      isPlayoffScore,
    } = req.body;

    // 1) Find which user owns this playerId:
    //    We'll look for the user whose boughtPlayers array includes playerId.
    const ownerUser = await User.findOne({
      boughtPlayers: playerId,
    });

    // If no user found owning this player, handle accordingly:
    if (!ownerUser) {
      return res.status(400).json({
        message: 'No user found who owns this playerId',
      });
    }

    // This is the user who owns the player
    const userId = ownerUser._id;

    // 2) Check if a stats doc already exists for this "match" 
    //    (defining match by userId, opponentUserId, and playerId).
    const existingStats = await PlayerStats.findOne({
      playerId,
      userId,
      opponentUserId,
    });

    if (existingStats && !isPlayoffScore) {
      // 3) If it exists, update the fields
      existingStats.battingStats = {
        runs: battingStats?.runs || 0,
        balls: battingStats?.balls || 0,
      };

      existingStats.bowlingStats = {
        runsGiven: bowlingStats?.runsGiven || 0,
        ballsBowled: bowlingStats?.ballsBowled || 0,
        wickets: wicketsTaken || 0, // store "wicketsTaken" here
      };

      existingStats.isMom = !!isMom; // convert to boolean

      await existingStats.save();

      // Update the Player document with cumulative stats
      await updatePlayerCumulativeStats(playerId);

      return res.status(200).json({
        message: 'Player stats updated successfully',
        data: existingStats,
      });
    } else {
      // 4) Otherwise, create a new stats document
      const newStats = new PlayerStats({
        playerId,
        userId,              // <== from the user who actually owns this player
        opponentUserId,
        battingStats: {
          runs: battingStats?.runs || 0,
          balls: battingStats?.balls || 0,
        },
        bowlingStats: {
          runsGiven: bowlingStats?.runsGiven || 0,
          ballsBowled: bowlingStats?.ballsBowled || 0,
          wickets: wicketsTaken || 0,
        },
        isMom: !!isMom,
      });

      await newStats.save();

      // Update the Player document with cumulative stats
      await updatePlayerCumulativeStats(playerId);

      return res.status(201).json({
        message: 'Player stats saved successfully',
        data: newStats,
      });
    }
  } catch (error) {
    console.error('Error saving/updating player stats:', error);
    return res.status(500).json({ message: 'Error saving player stats', error });
  }
});





// Fetch stats for a player


router.get('/stats/:playerId', async (req, res) => {
  const { playerId } = req.params;

  try {
    // Fetch stats for the given playerId
    const stats = await PlayerStats.find({ playerId })
      .populate('userId', 'name') // Populate user details
      .populate('opponentUserId', 'name'); // Populate opponent details

    // Calculate total stats
    let totalRuns = 0;
    let totalWickets = 0;

    stats.forEach(stat => {
      if (stat.battingStats?.runs) {
        totalRuns += stat.battingStats.runs;
      }
      if (stat.bowlingStats?.ballsBowled && stat.bowlingStats?.runsGiven) {
        totalWickets += Math.floor(stat.bowlingStats.ballsBowled / 6); // Example logic for wickets
      }
    });

    const response = {
      stats: stats.map(stat => ({
        id: stat._id,
        playerId: stat.playerId,
        user: stat.userId?.name || null,
        opponent: stat.opponentUserId?.name || null,
        battingStats: stat.battingStats,
        bowlingStats: stat.bowlingStats,
        isMom: stat.isMom,
        createdAt: stat.createdAt,
      })),
      totalStats: {
        totalScore: totalRuns,
        totalWickets,
      },
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching player stats:', error);
    res.status(500).json({ message: 'Error fetching player stats', error });
  }
});



// GET /stats-overview
router.get('/stats-overview', async (req, res) => {
  try {
    // 1) Fetch all PlayerStats docs, populating references
    const allStats = await PlayerStats.find()
      .populate({
        path: 'playerId',
        model: Player,
        select: 'name role type basePrice isActive',
      })
      .populate({
        path: 'userId',
        model: User,
        select: 'name teamName isActive isTournamentReady',
      })
      .populate({
        path: 'opponentUserId',
        model: User,
        select: 'name teamName isActive isTournamentReady',
      });

    // Filter out stats from users who aren't tournament ready
    const filteredStats = allStats.filter(stat => {
      const userReady = stat.userId?.isTournamentReady;
      const opponentReady = stat.opponentUserId?.isTournamentReady;
      return userReady && opponentReady;
    });

    // Helper functions
    const calcStrikeRate = (runs, balls) => {
      if (!balls || balls < 6) return 0;
      return (runs / balls) * 100;
    };
    const calcEconomy = (runsGiven, ballsBowled) => {
      if (!ballsBowled || ballsBowled < 6) return 99_999;
      return (runsGiven / (ballsBowled / 6));
    };

    // 2) Variables to track single-match records
    let highestStrikeRateDoc = null;
    let highestSRValue = 0;
    let bestEconomicalBowler = null;
    let bestEconomyDoc = null;
    let bestEconValue = 99_999; // track minimum economy

    let highestWicketsDoc = null;
    let highestWicketsCount = 0;

    let highestScoreDoc = null;
    let highestScoreRuns = 0;

    // 3) Variables to track total runs/wickets (leading scorers)
    const totalRunsMap = {};
    const totalWicketsMap = {};
    const matchCountMap = {};
    const totalBallsBowledMap = {};
    const momCountMap = {};

    // 4) Arrays for 5-wicket hauls, 4-wicket hauls, centuries, half-centuries
    const highestFiveWicketHauls = [];
    const highestFourWicketHauls = [];
    const centuries = [];
    const halfCenturies = [];

    // 5) Iterate over every stats doc, compute the relevant info
    filteredStats.forEach((statDoc) => {
      const {
        playerId,
        userId,
        opponentUserId,
        battingStats,
        bowlingStats,
        createdAt,
      } = statDoc;

      // Basic checks
      const playerName = playerId?.name ?? 'Unknown Player';
      const teamName = userId?.teamName ?? 'Unknown Team';
      const opponentName = opponentUserId?.teamName ?? 'Unknown Opponent';

      // A) Single-match computations
      const runs = battingStats?.runs || 0;
      const balls = battingStats?.balls || 0;
      const sr = calcStrikeRate(runs, balls);

      const runsGiven = bowlingStats?.runsGiven || 0;
      const ballsBowled = bowlingStats?.ballsBowled || 0;
      const wickets = bowlingStats?.wickets || 0;
      const economy = calcEconomy(runsGiven, ballsBowled);

      // 1) Highest Strike Rate
      if (sr > highestSRValue) {
        highestSRValue = sr;
        highestStrikeRateDoc = {
          playerName,
          teamName,
          strikeRate: parseFloat(sr.toFixed(2)),
        };
      }

      // 2) Best Economy
      if (economy < bestEconValue) {
        bestEconValue = economy;
        bestEconomicalBowler = {
          playerName,
          teamName,
          economy: parseFloat(economy.toFixed(2)),
        };
      }

      // 3) Highest Wicket Taker (single match)
      if (wickets > highestWicketsCount) {
        highestWicketsCount = wickets;
        highestWicketsDoc = {
          playerName,
          teamName,
          wickets,
          opponentTeam: opponentName,
        };
      }

      // 4) Highest Score (single match)
      if (runs > highestScoreRuns) {
        highestScoreRuns = runs;
        highestScoreDoc = {
          playerName,
          teamName,
          opponentTeam: opponentName,
          score: runs,
        };
      }

      // B) Totals for leading wicket taker / run scorer
      const pId = String(playerId._id); // convert to string key
      if (!totalRunsMap[pId]) totalRunsMap[pId] = 0;
      if (!totalWicketsMap[pId]) totalWicketsMap[pId] = 0;
      totalRunsMap[pId] += runs;
      totalWicketsMap[pId] += wickets;

      // B1) Count matches per player
      if (!matchCountMap[pId]) matchCountMap[pId] = 0;
      matchCountMap[pId] += 1;

      // B2) Track total balls bowled per player
      if (!totalBallsBowledMap[pId]) totalBallsBowledMap[pId] = 0;
      totalBallsBowledMap[pId] += ballsBowled;

      // B3) Check if this stats doc is MoM (CHANGED to `isMom`)
      if (statDoc.isMom) {
        if (!momCountMap[pId]) momCountMap[pId] = 0;
        momCountMap[pId] += 1;
      }

      // C) Specialized arrays
      // 5-wicket hauls => if wickets >= 5
      if (wickets >= 5) {
        highestFiveWicketHauls.push({
          playerName,
          teamName,
          opponentTeam: opponentName,
          wickets,
          date: createdAt,
        });
      }
      // 4-wicket hauls => if wickets == 4
      if (wickets === 4) {
        highestFourWicketHauls.push({
          playerName,
          teamName,
          opponentTeam: opponentName,
          wickets,
          date: createdAt,
        });
      }
      // Centuries => if runs >= 100
      if (runs >= 100) {
        centuries.push({
          playerName,
          teamName,
          againstTeam: opponentName,
          runs,
          date: createdAt,
        });
      }
      // Half-centuries => if 50 <= runs < 100
      else if (runs >= 50 && runs < 100) {
        halfCenturies.push({
          playerName,
          teamName,
          againstTeam: opponentName,
          runs,
          date: createdAt,
        });
      }
    });

    // 6) Find overall leading wicket taker & run scorer
    let leadingWicketTaker = null;
    let maxWickets = 0;

    let leadingRunScorer = null;
    let maxRuns = 0;

    for (let playerStat of filteredStats) {
      console.log(playerStat)
      const pid = String(playerStat.playerId._id);
      const playerName = playerStat.playerId?.name ?? 'Unknown Player';
      const teamName = playerStat.userId?.teamName ?? 'Unknown Team';

      if (totalRunsMap[pid] > maxRuns) {
        maxRuns = totalRunsMap[pid];
        leadingRunScorer = {
          playerName,
          teamName,
          totalRuns: maxRuns,
        };
      }
      if (totalWicketsMap[pid] > maxWickets) {
        maxWickets = totalWicketsMap[pid];
        leadingWicketTaker = {
          playerName,
          teamName,
          totalWickets: maxWickets,
        };
      }
    }

    // Build map of player info
    const playerInfoMap = {};
    filteredStats.forEach((statDoc) => {
      const pid = String(statDoc.playerId._id);
      if (!playerInfoMap[pid]) {
        playerInfoMap[pid] = {
          playerName: statDoc.playerId?.name || 'Unknown Player',
          teamName: statDoc.userId?.teamName || 'Unknown Team',
        };
      }
    });

    // Top 5 run scorers
    const runArray = Object.entries(totalRunsMap).map(([pid, runs]) => {
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        runs,
      };
    });
    runArray.sort((a, b) => b.runs - a.runs);
    const top5RunScorers = runArray.slice(0, 5);

    // Top 5 wicket takers
    const wicketArray = Object.entries(totalWicketsMap).map(([pid, wickets]) => {
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        wickets,
      };
    });
    wicketArray.sort((a, b) => b.wickets - a.wickets);
    const top5WicketTakers = wicketArray.slice(0, 5);

    // Top 5 MOM
    const momArray = Object.entries(momCountMap).map(([pid, count]) => {
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        momCount: count,
      };
    });
    // Sort descending by number of MoM
    momArray.sort((a, b) => b.momCount - a.momCount);
    const top5MOM = momArray.slice(0, 5);

    // Top 5 Bowler by Bowling Strike Rate
    const bowlingStrikeArray = Object.entries(totalBallsBowledMap).map(([pid, balls]) => {
      const w = totalWicketsMap[pid] || 0;
      let strikeRate = Number.POSITIVE_INFINITY;
      if (w > 0) {
        strikeRate = balls / w;
      }
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        strikeRate,
      };
    });
    const validBowlingStrikeArray = bowlingStrikeArray.filter(item => item.strikeRate !== Infinity);
    validBowlingStrikeArray.sort((a, b) => a.strikeRate - b.strikeRate);
    const top5BowlingStrikeRate = validBowlingStrikeArray.slice(0, 5);

    // Top 5 Best Batting Average
    const averageArray = Object.entries(matchCountMap).map(([pid, matchCount]) => {
      const runs = totalRunsMap[pid] || 0;
      // Calculate average as runs per match (since we don't track dismissals)
      const avg = matchCount > 0 ? (runs / matchCount) : 0;
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        matches: matchCount,
        totalRuns: runs,
        average: avg,
      };
    });
    averageArray.sort((a, b) => b.average - a.average);
    const top5BestBattingAverage = averageArray.slice(0, 5);

    // 7) Construct final response
    const response = {
      highestStrikeRate: highestStrikeRateDoc || {
        playerName: '',
        teamName: '',
        strikeRate: 0,
      },
      bestEconomicalBowler: bestEconomicalBowler || {
        playerName: '',
        teamName: '',
        economy: 0,
      },
      highestWicketTakerInMatch: highestWicketsDoc || {
        playerName: '',
        teamName: '',
        wickets: 0,
        opponentTeam: '',
      },
      highestScore: highestScoreDoc || {
        playerName: '',
        teamName: '',
        opponentTeam: '',
        score: 0,
      },
      leadingWicketTaker: leadingWicketTaker || {
        playerName: '',
        teamName: '',
        totalWickets: 0,
      },
      leadingRunScorer: leadingRunScorer || {
        playerName: '',
        teamName: '',
        totalRuns: 0,
      },
      highestFiveWicketHauls,
      highestFourWicketHauls,
      centuries,
      halfCenturies,

      // Existing top 5 arrays
      top5RunScorers,
      top5WicketTakers,

      // New fields
      top5MOM,
      top5BowlingStrikeRate,
      top5BestBattingAverage,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('Error generating StatsOverview:', err);
    return res
      .status(500)
      .json({ message: 'Error generating stats overview', error: err });
  }
});






// GET /player-details/:playerId - Get detailed stats for a specific player
router.get('/player-details/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;

    // Find the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: 'Player not found' });
    }

    // Find the user who owns this player
    const ownerUser = await User.findOne({ boughtPlayers: playerId });
    if (!ownerUser) {
      return res.status(404).json({ message: 'Player owner not found' });
    }

    // Get all stats for this player
    const stats = await PlayerStats.find({ playerId })
      .populate({
        path: 'opponentUserId',
        model: User,
        select: 'teamName'
      })
      .sort({ createdAt: 1 });

    // Calculate totals and averages
    let totalRuns = 0;
    let totalBalls = 0;
    let totalWickets = 0;
    let totalRunsGiven = 0;
    let totalBallsBowled = 0;
    let momCount = 0;
    let matchCount = stats.length;

    // Helper functions
    const calcStrikeRate = (runs, balls) => {
      if (!balls || balls < 1) return 0;
      return (runs / balls) * 100;
    };

    const calcEconomy = (runsGiven, ballsBowled) => {
      if (!ballsBowled || ballsBowled < 6) return 0;
      return (runsGiven / (ballsBowled / 6));
    };

    const calcBowlingStrikeRate = (ballsBowled, wickets) => {
      if (!wickets || wickets < 1) return 0;
      return ballsBowled / wickets;
    };

    // Build match history
    const matchHistory = stats.map((stat, index) => {
      const runs = stat.battingStats?.runs || 0;
      const balls = stat.battingStats?.balls || 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;

      // Add to totals
      totalRuns += runs;
      totalBalls += balls;
      totalWickets += wickets;
      totalRunsGiven += runsGiven;
      totalBallsBowled += ballsBowled;
      if (stat.isMom) momCount++;

      return {
        matchNumber: index + 1,
        date: stat.createdAt,
        teamName: ownerUser.teamName,
        opponentTeam: stat.opponentUserId?.teamName || 'Unknown Team',
        runs: runs,
        balls: balls,
        wickets: wickets,
        runsGiven: runsGiven,
        isMom: stat.isMom || false
      };
    });

    // Calculate averages
    const average = matchCount > 0 ? totalRuns / matchCount : 0;
    const strikeRate = calcStrikeRate(totalRuns, totalBalls);
    const economy = calcEconomy(totalRunsGiven, totalBallsBowled);
    const bowlingStrikeRate = calcBowlingStrikeRate(totalBallsBowled, totalWickets);

    // Determine if this is batting or bowling focused
    const isBattingFocused = totalRuns > totalWickets * 10; // Simple heuristic

    const response = {
      playerName: player.name,
      teamName: ownerUser.teamName,
      type: isBattingFocused ? 'batting' : 'bowling',
      totalRuns: totalRuns,
      totalWickets: totalWickets,
      average: parseFloat(average.toFixed(2)),
      strikeRate: parseFloat(strikeRate.toFixed(2)),
      economy: parseFloat(economy.toFixed(2)),
      bowlingStrikeRate: parseFloat(bowlingStrikeRate.toFixed(1)),
      momCount: momCount,
      matchesPlayed: matchCount,
      matchHistory: matchHistory
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching player details:', error);
    res.status(500).json({ message: 'Error fetching player details', error: error.message });
  }
});

router.get('/insights/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;
    const insight = await generatePlayerInsight(playerId);

    if (insight?.error === 'player-not-found') {
      return res.status(404).json({ message: 'Player not found' });
    }

    return res.json(insight);
  } catch (error) {
    console.error('Error generating player insight:', error);
    return res.status(500).json({ message: 'Error generating insight', error: error.message });
  }
});

router.post('/compare', async (req, res) => {
  try {
    const { playerAId, playerBId } = req.body;

    if (!playerAId || !playerBId) {
      return res.status(400).json({ message: 'playerAId and playerBId are required' });
    }

    const [insightA, insightB] = await Promise.all([
      generatePlayerInsight(playerAId),
      generatePlayerInsight(playerBId),
    ]);

    if (insightA?.error === 'player-not-found' || insightB?.error === 'player-not-found') {
      return res.status(404).json({ message: 'One or both players not found' });
    }

    if (!insightA.hasStats || !insightB.hasStats) {
      return res.status(400).json({
        message: 'Both players need recorded stats for a comparison.',
      });
    }

    const recommendation = buildComparisonRecommendation(insightA, insightB);

    return res.json({
      players: [
        {
          playerId: insightA.playerId,
          playerName: insightA.playerName,
          teamName: insightA.teamName,
          roleFocus: insightA.roleFocus,
          formScore: insightA.form?.score || null,
          batting: insightA.batting,
          bowling: insightA.bowling,
        },
        {
          playerId: insightB.playerId,
          playerName: insightB.playerName,
          teamName: insightB.teamName,
          roleFocus: insightB.roleFocus,
          formScore: insightB.form?.score || null,
          batting: insightB.batting,
          bowling: insightB.bowling,
        },
      ],
      recommendation,
    });
  } catch (error) {
    console.error('Error comparing players:', error);
    return res.status(500).json({ message: 'Error comparing players', error: error.message });
  }
});

module.exports = router;



