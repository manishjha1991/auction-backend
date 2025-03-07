const express = require('express');
const router = express.Router();
const PlayerStats = require('../models/PlayerStats'); // Adjust the path as needed
const Player = require('../models/Player'); // Adjust the path
const User = require('../models/User'); // Adjust the path
const UserPlayer = require('../models/UserPlayer'); // Adjust the path
// Load list of players with playerId and userId

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

    if (existingStats) {
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
        select: 'name teamName isActive',
      })
      .populate({
        path: 'opponentUserId',
        model: User,
        select: 'name teamName isActive',
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
    const totalRunsMap        = {};  
    const totalWicketsMap     = {};  
    const matchCountMap       = {};  
    const totalBallsBowledMap = {};  
    const momCountMap         = {};  

    // 4) Arrays for 5-wicket hauls, 4-wicket hauls, centuries, half-centuries
    const highestFiveWicketHauls = []; 
    const highestFourWicketHauls = [];
    const centuries = [];
    const halfCenturies = [];

    // 5) Iterate over every stats doc, compute the relevant info
    allStats.forEach((statDoc) => {
      const { 
        playerId, 
        userId, 
        opponentUserId,
        battingStats,
        bowlingStats,
        createdAt,
      } = statDoc;

      // Basic checks
      const playerName   = playerId?.name ?? 'Unknown Player';
      const teamName     = userId?.teamName ?? 'Unknown Team';
      const opponentName = opponentUserId?.teamName ?? 'Unknown Opponent';

      // A) Single-match computations
      const runs  = battingStats?.runs || 0;
      const balls = battingStats?.balls || 0;
      const sr    = calcStrikeRate(runs, balls);

      const runsGiven   = bowlingStats?.runsGiven || 0;
      const ballsBowled = bowlingStats?.ballsBowled || 0;
      const wickets     = bowlingStats?.wickets || 0;
      const economy     = calcEconomy(runsGiven, ballsBowled);
      
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
      if (!totalRunsMap[pId])     totalRunsMap[pId] = 0;
      if (!totalWicketsMap[pId])  totalWicketsMap[pId] = 0;
      totalRunsMap[pId]    += runs;
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

    for (let playerStat of allStats) {
      console.log(playerStat)
      const pid       = String(playerStat.playerId._id);
      const playerName= playerStat.playerId?.name ?? 'Unknown Player';
      const teamName  = playerStat.userId?.teamName ?? 'Unknown Team';

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
    allStats.forEach((statDoc) => {
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
      const avg = matchCount > 0 ? (runs / 10) : 0;
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






module.exports = router;



