const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');
const PlayerStats = require('../models/PlayerStats'); // Adjust the path as needed
const Player = require('../models/Player'); // Adjust the path
const User = require('../models/User'); // Adjust the path
const UserPlayer = require('../models/UserPlayer'); // Adjust the path
const MatchResult = require('../models/MatchResult');
const Fixture = require('../models/Fixture');
const authenticateJWT = require('../middleware/authJWT');
const requireAdmin = require('../middleware/requireAdmin');
const {
  cacheConfig,
  invalidateCache,
  registerExtraCache,
  clearAllCaches,
  registerStatsOverviewInvalidator,
} = require('../utils/cache');
const { upsertLiveCareerSummaryForPlayer } = require('../utils/playerCareerSummary');
const { invalidateCareerSummaryCache } = require('../utils/cplReadCaches');

// 🚀 PERFORMANCE: Create cache instance (5 minute TTL for stats) - keeping for backward compatibility
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
registerExtraCache(cache);
registerStatsOverviewInvalidator(() => cache.del('stats-overview'));
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
    lastFiveTotals.battingBalls >= 10
      ? (lastFiveTotals.battingRuns / lastFiveTotals.battingBalls) * 100
      : 0;

  const overallAvg = matchCount > 0 ? totals.battingRuns / matchCount : 0;
  const overallStrikeRate =
    totals.battingBalls >= 10 ? (totals.battingRuns / totals.battingBalls) * 100 : 0;

  const economy =
    totals.ballsBowled >= 12 && totals.wickets >= 1 ? totals.runsGiven / (totals.ballsBowled / 6 || 1) : 0;
  const bowlingStrikeRate =
    totals.wickets > 0 ? totals.ballsBowled / totals.wickets : 0;
  const recentEconomy =
    lastFiveTotals.ballsBowled >= 12 && lastFiveTotals.wickets >= 1
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
        strikeRate: balls >= 10 ? roundNumber((runs / balls) * 100) : null,
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

const classifyRole = (roleFocus = '') => {
  const text = (roleFocus || '').toLowerCase();
  if (text.includes('all') || text.includes('round')) return 'allrounder';
  if (text.includes('keeper')) return 'keeper';
  if (text.includes('bowl')) return 'bowler';
  return 'batter';
};

const battingImpactScore = (insight = {}) => {
  if (!insight.batting) return 0;
  const recentAvg = insight.batting.recentAverage || 0;
  const overallAvg = insight.batting.average || 0;
  const sr = insight.batting.recentStrikeRate || 0;
  return recentAvg * 0.6 + overallAvg * 0.4 + sr / 8;
};

const bowlingImpactScore = (insight = {}) => {
  if (!insight.bowling) return 0;
  const wickets = insight.bowling.wicketsPerMatch || 0;
  const economy = insight.bowling.economy || 0;
  const strike = insight.bowling.strikeRate || 0;
  return wickets * 18 - economy * 1.5 - strike * 0.2;
};

const overallImpactScore = (insight, roleType) => {
  const base = (insight.form?.score || 0) * 0.8;
  const batting = battingImpactScore(insight);
  const bowling = bowlingImpactScore(insight);
  const roleWeight =
    roleType === 'allrounder'
      ? 12
      : roleType === 'bowler'
      ? 6
      : roleType === 'keeper'
      ? 4
      : 8;
  return base + batting + bowling + roleWeight;
};

const buildPlayerNarrative = (insight, roleType) => {
  const fragments = [];
  if (insight.form?.score) {
    fragments.push(`form score ${insight.form.score}`);
  }
  if ((roleType === 'batter' || roleType === 'keeper' || roleType === 'allrounder') && insight.batting) {
    fragments.push(
      `averaging ${roundNumber(insight.batting.recentAverage)} runs at ${roundNumber(
        insight.batting.recentStrikeRate
      )} SR recently`
    );
  }
  if ((roleType === 'bowler' || roleType === 'allrounder') && insight.bowling) {
    fragments.push(
      `${roundNumber(insight.bowling.wicketsPerMatch)} wickets/match with ${roundNumber(
        insight.bowling.economy
      )} economy`
    );
  }
  return fragments.join(', ');
};

const roleDescriptor = (roleType) => {
  switch (roleType) {
    case 'bowler':
      return 'strike bowler';
    case 'allrounder':
      return '3D impact player';
    case 'keeper':
      return 'keeper-batter';
    default:
      return 'top-order option';
  }
};

const buildComparisonRecommendation = (insightA, insightB) => {
  const roleA = classifyRole(insightA.roleFocus);
  const roleB = classifyRole(insightB.roleFocus);

  const scoreA = overallImpactScore(insightA, roleA);
  const scoreB = overallImpactScore(insightB, roleB);
  const edge = scoreA - scoreB;

  const leader = edge >= 0 ? insightA : insightB;
  const leaderRole = edge >= 0 ? roleA : roleB;
  const trailer = edge >= 0 ? insightB : insightA;
  const trailerRole = edge >= 0 ? roleB : roleA;
  const leaderNarrative = buildPlayerNarrative(leader, leaderRole);
  const trailerNarrative = buildPlayerNarrative(trailer, trailerRole);

  if (Math.abs(edge) < 8) {
    return `It is genuinely close: ${insightA.playerName} (${leaderNarrative || 'balanced returns'}) and ${insightB.playerName} (${trailerNarrative || 'balanced returns'}) are delivering comparable impact. Let matchups decide—lean ${roleDescriptor(
      roleA
    )} for powerplay stability, or ${roleDescriptor(roleB)} if you need flexibility.`;
  }

  return `${leader.playerName} profiles as the superior ${roleDescriptor(
    leaderRole
  )} right now—${leaderNarrative || 'more complete contributions'}. ${trailer.playerName} still offers ${trailerNarrative ||
    'steady output'}, so slot them in when conditions suit their strengths.`;
};

// Helper: rebuild live career block from PlayerStats, merge with historical, sync Player for Top Rankings
const updatePlayerCumulativeStats = async (playerId) => {
  try {
    await upsertLiveCareerSummaryForPlayer(playerId);
  } catch (error) {
    console.error('Error updating cumulative stats:', error);
  }
};

const applyPlayerStatDelta = async (playerId, delta = {}) => {
  const {
    runs = 0,
    balls = 0,
    runsGiven = 0,
    ballsBowled = 0,
    wickets = 0,
    mom = 0,
    matches = 0,
  } = delta;

  const inc = {};
  // Include all deltas, even if 0 or negative (for corrections)
  // Only skip if the value is explicitly undefined/null
  // Note: $inc can handle negative values for decrements
  if (runs !== undefined && runs !== null && runs !== 0) inc.totalRuns = runs;
  if (balls !== undefined && balls !== null && balls !== 0) inc.totalBalls = balls;
  if (runsGiven !== undefined && runsGiven !== null && runsGiven !== 0) inc.totalRunsGiven = runsGiven;
  if (ballsBowled !== undefined && ballsBowled !== null && ballsBowled !== 0) inc.totalBallsBowled = ballsBowled;
  if (wickets !== undefined && wickets !== null && wickets !== 0) inc.totalWickets = wickets;
  if (mom !== undefined && mom !== null && mom !== 0) inc.momCount = mom;
  if (matches !== undefined && matches !== null && matches !== 0) inc.matchesPlayed = matches;

  if (!Object.keys(inc).length) {
    console.log('No stat deltas to apply for player:', playerId);
    return;
  }

  try {
    const result = await Player.findByIdAndUpdate(playerId, { $inc: inc });
    if (!result) {
      console.error('Player not found for stat delta update:', playerId);
      return;
    }
    console.log(`✅ Updated player ${playerId} totals:`, inc);
  } catch (error) {
    console.error('Failed to apply stat delta', { playerId, delta, error: error.message, stack: error.stack });
    throw error; // Re-throw to ensure caller knows about the failure
  }
};

const savePlayerStatsEntry = async (payload = {}) => {
  const {
    playerId,
    opponentUserId,
    battingStats,
    bowlingStats,
    wicketsTaken,
    isMom,
    isPlayoffScore,
    economy,
    extras,
  } = payload;

  if (!playerId) {
    const error = new Error('playerId is required');
    error.status = 400;
    throw error;
  }

  const ownerUser = await User.findOne({
    boughtPlayers: playerId,
  });

  if (!ownerUser) {
    const error = new Error('No user found who owns this playerId');
    error.status = 400;
    throw error;
  }

  const userId = ownerUser._id;
  const existingStats = await PlayerStats.findOne({
    playerId,
    userId,
    opponentUserId,
  });

  const newTotals = {
    runs: battingStats?.runs || 0,
    balls: battingStats?.balls || 0,
    runsGiven: bowlingStats?.runsGiven || 0,
    ballsBowled: bowlingStats?.ballsBowled || 0,
    wickets:
      wicketsTaken !== undefined && wicketsTaken !== null
        ? wicketsTaken
        : bowlingStats?.wickets || 0,
    mom: isMom ? 1 : 0,
  };

  const deltaTotals = {
    runs: 0,
    balls: 0,
    runsGiven: 0,
    ballsBowled: 0,
    wickets: 0,
    mom: 0,
    matches: 0,
  };

  // If existing stats found AND it's NOT a playoff score → UPDATE (no duplicates for regular matches)
  // If existing stats found AND it IS a playoff score → CREATE NEW (allow duplicates for playoff matches)
  // If no existing stats → CREATE NEW
  if (existingStats && !isPlayoffScore) {
    const previousTotals = {
      runs: existingStats.battingStats?.runs || 0,
      balls: existingStats.battingStats?.balls || 0,
      runsGiven: existingStats.bowlingStats?.runsGiven || 0,
      ballsBowled: existingStats.bowlingStats?.ballsBowled || 0,
      wickets: existingStats.bowlingStats?.wickets || 0,
      mom: existingStats.isMom ? 1 : 0,
    };
    deltaTotals.runs = newTotals.runs - previousTotals.runs;
    deltaTotals.balls = newTotals.balls - previousTotals.balls;
    deltaTotals.runsGiven = newTotals.runsGiven - previousTotals.runsGiven;
    deltaTotals.ballsBowled = newTotals.ballsBowled - previousTotals.ballsBowled;
    deltaTotals.wickets = newTotals.wickets - previousTotals.wickets;
    deltaTotals.mom = newTotals.mom - previousTotals.mom;

    existingStats.battingStats = {
      runs: battingStats?.runs || 0,
      balls: battingStats?.balls || 0,
    };

    existingStats.bowlingStats = {
      runsGiven: bowlingStats?.runsGiven || 0,
      ballsBowled: bowlingStats?.ballsBowled || 0,
      wickets: wicketsTaken !== undefined && wicketsTaken !== null ? wicketsTaken : (bowlingStats?.wickets || 0),
    };

    existingStats.isMom = !!isMom;
    
    // Store economy and extras in metadata
    if (!existingStats.metadata) {
      existingStats.metadata = {};
    }
    if (economy !== null && economy !== undefined) {
      existingStats.metadata.economy = Number(economy);
    }
    if (extras !== null && extras !== undefined) {
      existingStats.metadata.extras = Number(extras);
    }
    if (isPlayoffScore !== null && isPlayoffScore !== undefined) {
      existingStats.metadata.isPlayoffScore = !!isPlayoffScore;
    }

    await existingStats.save();
    
    // Apply delta to player totals (non-blocking - don't fail OCR upload if this fails)
    try {
      console.log(`📊 Updating player ${playerId} totals with delta:`, deltaTotals);
      await applyPlayerStatDelta(playerId, deltaTotals);
      await upsertLiveCareerSummaryForPlayer(playerId);
      invalidateCareerSummaryCache();
    } catch (deltaError) {
      console.error(`⚠️ Failed to update player totals for ${playerId}, but stats saved successfully:`, deltaError);
      // Don't throw - stats are already saved, this is just a bonus update
    }

    // 🚀 PERFORMANCE: Invalidate stats-overview and players data cache when stats are updated
    cache.del('stats-overview');
    invalidateCache('players:data'); // Invalidate top rankings cache

    return { action: 'updated', doc: existingStats };
  }

  deltaTotals.runs = newTotals.runs;
  deltaTotals.balls = newTotals.balls;
  deltaTotals.runsGiven = newTotals.runsGiven;
  deltaTotals.ballsBowled = newTotals.ballsBowled;
  deltaTotals.wickets = newTotals.wickets;
  deltaTotals.mom = newTotals.mom;
  deltaTotals.matches = 1;

  const newStats = new PlayerStats({
    playerId,
    userId,
    opponentUserId,
    battingStats: {
      runs: battingStats?.runs || 0,
      balls: battingStats?.balls || 0,
    },
    bowlingStats: {
      runsGiven: bowlingStats?.runsGiven || 0,
      ballsBowled: bowlingStats?.ballsBowled || 0,
      wickets: wicketsTaken !== undefined && wicketsTaken !== null ? wicketsTaken : (bowlingStats?.wickets || 0),
    },
    isMom: !!isMom,
    metadata: {
      economy: economy !== null && economy !== undefined ? Number(economy) : null,
      extras: extras !== null && extras !== undefined ? Number(extras) : null,
      isPlayoffScore: !!isPlayoffScore,
    },
  });

    await newStats.save();
    
    // Apply delta to player totals (non-blocking - don't fail OCR upload if this fails)
    try {
      console.log(`📊 Adding new stats for player ${playerId} with delta:`, deltaTotals);
      await applyPlayerStatDelta(playerId, deltaTotals);
      await upsertLiveCareerSummaryForPlayer(playerId);
      invalidateCareerSummaryCache();
    } catch (deltaError) {
      console.error(`⚠️ Failed to update player totals for ${playerId}, but stats saved successfully:`, deltaError);
      // Don't throw - stats are already saved, this is just a bonus update
    }

    // 🚀 PERFORMANCE: Invalidate stats-overview and players data cache when new stats are added
    cache.del('stats-overview');
    invalidateCache('players:data'); // Invalidate top rankings cache

    return { action: 'created', doc: newStats };
};

router.get('/list', async (req, res) => {
  // 🚀 PERFORMANCE: Check cache first (2 minute cache for player stats list)
  const { userId } = req.query;
  const cacheKey = `player-stats-list:${userId}`;
  const cached = cacheConfig.medium.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  try {

    // Check if the user exists and populate the boughtPlayers field
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const user = await User.findById(userId).populate({
      path: 'boughtPlayers',
      match: { isSold: true, isActive: true },
      select:
        '_id name type role basePrice style overallScore profilePicture isSold isActive'
    }).lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Skip if user is not tournament ready
    if (!user.isTournamentReady) {
      return res.status(403).json({ message: 'User is not tournament ready' });
    }

    const isAdmin = user.isAdmin;
    let playersToSend = [];

    // Helper function to convert balls into overs (X.Y format)
    const convertBallsToOvers = (balls) => {
      const b = balls || 0;
      const overs = Math.floor(b / 6);
      const remainder = b % 6;
      return `${overs}.${remainder}`;
    };

    // 🚀 PERFORMANCE: Run queries in parallel for faster execution
    const [playersResult, playoffTeamsResult] = await Promise.all([
      // Fetch players (admin or user's bought players)
      isAdmin 
        ? Player.find(
            { isSold: true, isActive: true },
            '_id name type role basePrice style overallScore profilePicture isSold isActive'
          ).lean()
        : Promise.resolve(user.boughtPlayers || []),
      // Fetch playoff teams in parallel (not dependent on players)
      User.find({
        isActive: true,
        teamName: { $exists: true, $ne: null, $ne: 'NA' }
      })
        .sort({ teamName: 1 })
        .limit(5)
        .lean()
    ]);

    playersToSend = playersResult;

    // 🚀 PERFORMANCE: Batch fetch all PlayerStats for all players at once (instead of N queries)
    const allPlayerIds = playersToSend.map(p => p._id);
    const allStats = allPlayerIds.length > 0 
      ? await PlayerStats.find({ 
          playerId: { $in: allPlayerIds } 
        }).lean()
      : [];
    
    // 🚀 PERFORMANCE: Batch fetch all opponent users at once (instead of N*M queries)
    const allOpponentIds = [...new Set(allStats.map(s => s.opponentUserId).filter(Boolean))];
    const opponentUsers = allOpponentIds.length > 0
      ? await User.find({ 
          _id: { $in: allOpponentIds } 
        }).select('_id teamName').lean()
      : [];
    
    // Create a map for O(1) lookup
    const opponentMap = {};
    opponentUsers.forEach(u => {
      opponentMap[String(u._id)] = u.teamName || 'Unknown';
    });

    // 🚀 PERFORMANCE: Create stats index by playerId for O(1) lookup instead of O(N) filter
    const statsByPlayerId = new Map();
    allStats.forEach(stat => {
      const playerIdStr = String(stat.playerId);
      if (!statsByPlayerId.has(playerIdStr)) {
        statsByPlayerId.set(playerIdStr, []);
      }
      statsByPlayerId.get(playerIdStr).push(stat);
    });

    // 🚀 PERFORMANCE: Process synchronously (no async needed, just data transformation)
    const playersWithDetails = playersToSend.map((player) => {
      // Get stats for this player from pre-indexed data (O(1) lookup)
      const stats = statsByPlayerId.get(String(player._id)) || [];

      // Calculate batting performance per match (using pre-fetched opponent data)
      const battingStats = stats.map((stat) => ({
        match: stat.matchName,
        runs: stat.battingStats?.runs || 0,
        balls: stat.battingStats?.balls || 0,
        mom: stat.isMom || false,
        // Use pre-fetched opponent map (no database query)
        against: stat.opponentUserId 
          ? (opponentMap[String(stat.opponentUserId)] || 'Unknown')
          : 'Unknown'
      }));

      // Calculate bowling performance per match (using pre-fetched opponent data)
      const bowlingStats = stats.map((stat) => ({
        match: stat.matchName,
        overs: convertBallsToOvers(stat.bowlingStats?.ballsBowled),
        wickets: stat.bowlingStats?.wickets || 0,
        runs: stat.bowlingStats?.runsGiven || 0,
        mom: stat.isMom || false,
        // Use pre-fetched opponent map (no database query)
        against: stat.opponentUserId 
          ? (opponentMap[String(stat.opponentUserId)] || 'Unknown')
          : 'Unknown'
      }));

      // Calculate total stats (for response only - do NOT update Player collection)
      // Note: Player totals are updated via applyPlayerStatDelta when stats are saved
      // This endpoint should only READ data, not modify it
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
    });

    // ---------------------------
    // Create Playoff Fixtures
    // ---------------------------
    // For this example, we are simply querying the top five teams (active teams with a valid teamName).
    // Adjust the sorting field based on your ranking criteria if available.
    const playoffTeams = playoffTeamsResult;
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

    const response = { players: playersWithDetails, playoffFixtures };
    
    // 🚀 PERFORMANCE: Cache the response (2 minute cache)
    cacheConfig.medium.set(cacheKey, response);
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching player list:', error);
    res.status(500).json({ message: 'Error fetching player list', error });
  }
});





// Store player stats
// routes/playerStats.js (example)
router.post('/store', async (req, res) => {
  try {
    const result = await savePlayerStatsEntry(req.body);
    if (result.action === 'updated') {
      return res.status(200).json({
        message: 'Player stats updated successfully',
        data: result.doc,
      });
    }
    return res.status(201).json({
      message: 'Player stats saved successfully',
      data: result.doc,
    });
  } catch (error) {
    console.error('Error saving/updating player stats:', error);
    const statusCode = error.status || 500;
    return res.status(statusCode).json({
      message: error.message || 'Error saving player stats',
    });
  } finally {
    // 🚀 PERFORMANCE: Invalidate stats-overview and players data cache when stats are saved/updated
    cache.del('stats-overview');
    invalidateCache('players:data'); // Invalidate top rankings cache
  }
});

// POST /api/player-stats/clear-all-cache - Clear ALL backend caches (stats, fixtures, players, users, news). Use after direct DB edits.
router.post('/clear-all-cache', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    clearAllCaches();
    res.json({ message: 'All caches cleared. Hard refresh the UI (Ctrl+Shift+R) to see fresh data.' });
  } catch (err) {
    console.error('Clear all cache error:', err);
    res.status(500).json({ message: err.message || 'Failed to clear cache' });
  }
});

// POST /api/player-stats/clear-cache - Call after clearing PlayerStats collection to avoid stale UI
// Optional: ?resetPlayerTotals=1 also resets totalRuns, totalWickets, matchesPlayed on Player collection
// Optional: ?clearStatsOverview=1 also deletes all PlayerStats and clears Fixture scores (highest/lowest team total)
router.post('/clear-cache', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data');

    const resetTotals = req.query.resetPlayerTotals === '1' || req.body?.resetPlayerTotals === true;
    const clearStatsOverview = req.query.clearStatsOverview === '1' || req.body?.clearStatsOverview === true;

    if (clearStatsOverview) {
      const [playerStatsResult, fixtureResult] = await Promise.all([
        PlayerStats.deleteMany({}),
        Fixture.updateMany(
          {},
          { $set: { team1Score: null, team2Score: null, team1Overs: null, team2Overs: null } }
        ),
      ]);
      return res.json({
        message: 'Stats overview fully cleared (PlayerStats + Fixture scores + cache). Hard refresh the UI.',
        playerStatsDeleted: playerStatsResult.deletedCount,
        fixturesCleared: fixtureResult.modifiedCount,
      });
    }

    if (resetTotals) {
      const r = await Player.updateMany(
        {},
        { $set: { totalRuns: 0, totalWickets: 0, matchesPlayed: 0, totalRunsGiven: 0, totalBalls: 0, totalBallsBowled: 0, momCount: 0 } }
      );
      return res.json({
        message: 'Stats cache cleared and Player totals reset. Hard refresh the UI (Ctrl+Shift+R).',
        playersReset: r.modifiedCount,
      });
    }

    res.json({ message: 'Stats cache cleared. Hard refresh the UI (Ctrl+Shift+R).' });
  } catch (err) {
    console.error('Clear cache error:', err);
    res.status(500).json({ message: err.message || 'Failed to clear cache' });
  }
});

router.post('/bulk-store', async (req, res) => {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ message: 'entries array is required' });
    }

    const results = [];
    const errors = [];

    for (const entry of entries) {
      try {
        const result = await savePlayerStatsEntry(entry);
        results.push({
          playerId: entry.playerId,
          action: result.action,
        });
      } catch (error) {
        errors.push({
          playerId: entry?.playerId || null,
          message: error.message || 'Failed to save player stats',
        });
      }
    }

    // 🚀 PERFORMANCE: Invalidate stats-overview, player-stats-list, and players data cache when stats are saved
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data'); // Invalidate top rankings cache

    return res.status(errors.length ? 207 : 200).json({
      message: 'Bulk player stats processed',
      results,
      errors,
    });
  } catch (error) {
    console.error('Error saving bulk player stats:', error);
    return res.status(500).json({ message: 'Error saving bulk player stats', error });
  }
});

const resolveOpponentUserId = async (rawOpponentUserId, opponentTeamName) => {
  if (rawOpponentUserId) return rawOpponentUserId;
  if (!opponentTeamName) return null;
  const regex = new RegExp(`^${escapeRegex(opponentTeamName.trim())}$`, 'i');
  const opponent = await User.findOne({ teamName: regex }).select('_id');
  return opponent ? opponent._id : null;
};

router.post('/bulk-store', async (req, res) => {
  try {
    const {
      entries = [],
      matchName,
      matchKey,
      fixtureId,
      isPlayoffScore,
    } = req.body || {};

    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ message: 'entries array is required' });
    }

    const warnings = [];
    let successCount = 0;

    for (const entry of entries) {
      if (!entry?.playerId) {
        warnings.push('Skipping entry with missing playerId');
        continue;
      }

      const ownerUser = await User.findOne({ boughtPlayers: entry.playerId });
      if (!ownerUser) {
        warnings.push(`No owner found for player ${entry.playerId}`);
        continue;
      }

      const batStats = sanitizeBattingStats(entry.battingStats);
      const bowlStats = sanitizeBowlingStats(entry.bowlingStats, entry.wicketsTaken);
      const resolvedOpponentUserId = await resolveOpponentUserId(
        entry.opponentUserId,
        entry.opponentTeamName
      );

      const normalizedMatchKey = entry.matchKey || matchKey || null;
      const normalizedMatchName = entry.matchName || matchName || null;
      const entryIsPlayoffScore =
        entry.isPlayoffScore !== undefined
          ? !!entry.isPlayoffScore
          : isPlayoffScore !== undefined
          ? !!isPlayoffScore
          : false;

      const query = {
        playerId: entry.playerId,
        userId: ownerUser._id,
      };
      if (normalizedMatchKey) {
        query.matchKey = normalizedMatchKey;
      } else if (resolvedOpponentUserId) {
        query.opponentUserId = resolvedOpponentUserId;
      }

      // Check for existing stats
      let statDoc = await PlayerStats.findOne(query);

      // Calculate new totals for delta calculation
      const newTotals = {
        runs: batStats?.runs || 0,
        balls: batStats?.balls || 0,
        runsGiven: bowlStats?.runsGiven || 0,
        ballsBowled: bowlStats?.ballsBowled || 0,
        wickets: bowlStats?.wickets || 0,
        mom: entry.isMom ? 1 : 0,
      };

      // Initialize delta totals
      const deltaTotals = {
        runs: 0,
        balls: 0,
        runsGiven: 0,
        ballsBowled: 0,
        wickets: 0,
        mom: 0,
        matches: 0,
      };

      // If existing stats found AND it's NOT a playoff score → UPDATE (no duplicates for regular matches)
      // If existing stats found AND it IS a playoff score → CREATE NEW (allow duplicates for playoff matches)
      // If no existing stats → CREATE NEW
      if (statDoc && !entryIsPlayoffScore) {
        // Calculate delta from previous stats
        const previousTotals = {
          runs: statDoc.battingStats?.runs || 0,
          balls: statDoc.battingStats?.balls || 0,
          runsGiven: statDoc.bowlingStats?.runsGiven || 0,
          ballsBowled: statDoc.bowlingStats?.ballsBowled || 0,
          wickets: statDoc.bowlingStats?.wickets || 0,
          mom: statDoc.isMom ? 1 : 0,
        };
        
        deltaTotals.runs = newTotals.runs - previousTotals.runs;
        deltaTotals.balls = newTotals.balls - previousTotals.balls;
        deltaTotals.runsGiven = newTotals.runsGiven - previousTotals.runsGiven;
        deltaTotals.ballsBowled = newTotals.ballsBowled - previousTotals.ballsBowled;
        deltaTotals.wickets = newTotals.wickets - previousTotals.wickets;
        deltaTotals.mom = newTotals.mom - previousTotals.mom;

        // Update existing entry (regular match)
        statDoc.opponentUserId = resolvedOpponentUserId || statDoc.opponentUserId || null;
        statDoc.matchName = normalizedMatchName || statDoc.matchName || null;
        statDoc.matchKey = normalizedMatchKey || statDoc.matchKey || null;
        statDoc.fixtureId = entry.fixtureId || fixtureId || statDoc.fixtureId || null;
        statDoc.isPlayoffScore = entryIsPlayoffScore;
        statDoc.battingStats = batStats;
        statDoc.bowlingStats = bowlStats;
        statDoc.isMom = !!entry.isMom;
        
        // Update metadata
        if (!statDoc.metadata) {
          statDoc.metadata = {};
        }
        if (entry.economy !== null && entry.economy !== undefined) {
          statDoc.metadata.economy = Number(entry.economy);
        }
        if (entry.extras !== null && entry.extras !== undefined) {
          statDoc.metadata.extras = Number(entry.extras);
        }
        statDoc.metadata.isPlayoffScore = entryIsPlayoffScore;

        await statDoc.save();
        
        // Apply delta to player totals
        await applyPlayerStatDelta(entry.playerId, deltaTotals);
        await upsertLiveCareerSummaryForPlayer(entry.playerId);
        invalidateCareerSummaryCache();
      } else {
        // Create new entry (either no existing stats OR it's a playoff score)
        // For new entries, delta equals the new totals
        deltaTotals.runs = newTotals.runs;
        deltaTotals.balls = newTotals.balls;
        deltaTotals.runsGiven = newTotals.runsGiven;
        deltaTotals.ballsBowled = newTotals.ballsBowled;
        deltaTotals.wickets = newTotals.wickets;
        deltaTotals.mom = newTotals.mom;
        deltaTotals.matches = 1;

        statDoc = new PlayerStats({
          playerId: entry.playerId,
          userId: ownerUser._id,
          opponentUserId: resolvedOpponentUserId || null,
          matchName: normalizedMatchName || null,
          matchKey: normalizedMatchKey || null,
          fixtureId: entry.fixtureId || fixtureId || null,
          isPlayoffScore: entryIsPlayoffScore,
          battingStats: batStats,
          bowlingStats: bowlStats,
          isMom: !!entry.isMom,
          metadata: {
            economy: entry.economy !== null && entry.economy !== undefined ? Number(entry.economy) : null,
            extras: entry.extras !== null && entry.extras !== undefined ? Number(entry.extras) : null,
            isPlayoffScore: entryIsPlayoffScore,
          },
        });

        await statDoc.save();
        
        // Apply delta to player totals (non-blocking - don't fail OCR upload if this fails)
        try {
          await applyPlayerStatDelta(entry.playerId, deltaTotals);
          await upsertLiveCareerSummaryForPlayer(entry.playerId);
          invalidateCareerSummaryCache();
        } catch (deltaError) {
          console.error(`⚠️ Failed to update player totals for ${entry.playerId}, but stats saved successfully:`, deltaError);
          // Don't throw - stats are already saved, this is just a bonus update
        }
      }

      successCount += 1;
    }

    // 🚀 PERFORMANCE: Invalidate stats-overview, player-stats-list, and players data cache when stats are saved
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data'); // Invalidate top rankings cache

    return res.status(200).json({
      message: 'Player stats saved successfully',
      count: successCount,
      warnings,
    });
  } catch (error) {
    console.error('Error saving bulk player stats:', error);
    return res.status(500).json({ message: 'Error saving bulk player stats', error });
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
    const skipCache = req.query.nocache === '1' || req.query.nocache === 'true';
    const cacheKey = 'stats-overview';
    if (!skipCache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }
    }

    // 1) Fetch all PlayerStats docs, populating references
    // 🚀 PERFORMANCE: Use .lean() for faster queries (returns plain JS objects)
    const allStats = await PlayerStats.find()
      .populate({
        path: 'playerId',
        model: Player,
        select: 'name role type basePrice isActive profilePicture',
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
      })
      .lean();

    // Filter stats for Stats Overview - only show current tournament (tournament-ready teams)
    // This keeps Stats Overview focused on the running tournament
    // Note: Rankings page uses /api/player/players/data which shows ALL historical stats
    const filteredStats = allStats.filter(stat => {
      const userReady = stat.userId?.isTournamentReady;
      const opponentReady = stat.opponentUserId?.isTournamentReady;
      return userReady && opponentReady;
    });

    const parseScore = (scoreValue) => {
      if (scoreValue === null || scoreValue === undefined) {
        return { runs: 0, wickets: 0, valid: false };
      }
      const scoreStr = String(scoreValue).trim();
      if (!scoreStr) return { runs: 0, wickets: 0, valid: false };
      if (scoreStr.includes('/')) {
        const [runsPart, wicketsPart] = scoreStr.split('/');
        const runs = Number.parseInt(runsPart, 10);
        const wickets = Number.parseInt(wicketsPart, 10);
        return {
          runs: Number.isNaN(runs) ? 0 : runs,
          wickets: Number.isNaN(wickets) ? 0 : wickets,
          valid: true,
        };
      }
      const runs = Number.parseInt(scoreStr, 10);
      return {
        runs: Number.isNaN(runs) ? 0 : runs,
        wickets: 0,
        valid: true,
      };
    };

    const fixtures = await Fixture.find({
      team1Score: { $ne: null },
      team2Score: { $ne: null },
      winner: { $ne: null },
    }).lean();

    const teamTotals = fixtures.flatMap((match) => {
      const team1Parsed = parseScore(match.team1Score);
      const team2Parsed = parseScore(match.team2Score);
      return [
        {
          teamName: match.team1,
          opponentTeam: match.team2,
          runs: team1Parsed.runs,
          overs: match.team1Overs || 0,
          wickets: team1Parsed.wickets,
        },
        {
          teamName: match.team2,
          opponentTeam: match.team1,
          runs: team2Parsed.runs,
          overs: match.team2Overs || 0,
          wickets: team2Parsed.wickets,
        },
      ];
    });

    // Helper functions
    const calcStrikeRate = (runs, balls) => {
      // Minimum 10 balls required for realistic strike rate calculation
      if (!balls || balls < 10) return 0;
      return (runs / balls) * 100;
    };
    const calcEconomy = (runsGiven, ballsBowled, wickets = 0) => {
      // Minimum 12 balls (2 overs) AND at least 1 wicket required for realistic economy calculation
      if (!ballsBowled || ballsBowled < 12 || wickets < 1) return 99_999;
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
    const totalRunsGivenMap = {};
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
      const playerType = playerId?.type ?? null;
      const profilePicture = playerId?.profilePicture ?? null;
      const teamName = userId?.teamName ?? 'Unknown Team';
      const opponentName = opponentUserId?.teamName ?? 'Unknown Opponent';

      // A) Single-match computations
      const runs = battingStats?.runs || 0;
      const balls = battingStats?.balls || 0;
      const sr = calcStrikeRate(runs, balls);

      const runsGiven = bowlingStats?.runsGiven || 0;
      const ballsBowled = bowlingStats?.ballsBowled || 0;
      const wickets = bowlingStats?.wickets || 0;
      const economy = calcEconomy(runsGiven, ballsBowled, wickets);

      // 1) Highest Strike Rate
      if (sr > highestSRValue) {
        highestSRValue = sr;
        highestStrikeRateDoc = {
          playerId: String(playerId._id),
          playerName,
          playerType,
          profilePicture,
          teamName,
          strikeRate: parseFloat(sr.toFixed(2)),
          opponentTeam: opponentName,
          runs,
          balls,
        };
      }

      // 2) Best Economy - Only consider realistic spells
      // Require: minimum 18 balls (3 overs) for normal cases (runsGiven > 0)
      // If 0 runs given, require either:
      //   - Minimum 30 balls (5 overs) OR
      //   - At least 2 wickets (to ensure it's a meaningful spell)
      // Also require at least 1 wicket
      const isRealisticEconomySpell = 
        wickets >= 1 && 
        ballsBowled >= 12 && 
        (runsGiven > 0 
          ? ballsBowled >= 18 
          : (ballsBowled >= 30 || wickets >= 2));
      
      if (isRealisticEconomySpell && economy < bestEconValue && economy !== 99_999) {
        bestEconValue = economy;
        bestEconomicalBowler = {
          playerId: String(playerId._id),
          playerName,
          playerType,
          profilePicture,
          teamName,
          economy: parseFloat(economy.toFixed(2)),
          opponentTeam: opponentName,
          wickets,
          runsGiven,
          ballsBowled,
        };
      }

      // 3) Highest Wicket Taker (single match)
      // Priority: 1) Most wickets, 2) Fewer runs given (better economy)
      const shouldUpdate = (() => {
        if (wickets > highestWicketsCount) {
          return true; // More wickets = better
        }
        if (wickets === highestWicketsCount && highestWicketsDoc) {
          // Same wickets, pick the one with fewer runs given
          return runsGiven < highestWicketsDoc.runsGiven;
        }
        return false;
      })();
      
      if (shouldUpdate) {
        highestWicketsCount = wickets;
        highestWicketsDoc = {
          playerId: String(playerId._id),
          playerName,
          playerType,
          profilePicture,
          teamName,
          wickets,
          opponentTeam: opponentName,
          runsGiven,
          ballsBowled,
        };
      }

      // 4) Highest Score (single match)
      if (runs > highestScoreRuns) {
        highestScoreRuns = runs;
        const matchSR = balls > 0 ? parseFloat(((runs / balls) * 100).toFixed(2)) : 0;
        highestScoreDoc = {
          playerId: String(playerId._id),
          playerName,
          playerType,
          profilePicture,
          teamName,
          opponentTeam: opponentName,
          score: runs,
          balls,
          strikeRate: matchSR,
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

      // B2b) Track total runs given per player (for economy)
      if (!totalRunsGivenMap[pId]) totalRunsGivenMap[pId] = 0;
      totalRunsGivenMap[pId] += runsGiven;

      // B3) Check if this stats doc is MoM (CHANGED to `isMom`)
      if (statDoc.isMom) {
        if (!momCountMap[pId]) momCountMap[pId] = 0;
        momCountMap[pId] += 1;
      }

      // C) Specialized arrays (also store playerId for efficient counting)
      const pid = String(playerId._id);
      // 5-wicket hauls => if wickets >= 5
      if (wickets >= 5) {
        highestFiveWicketHauls.push({
          playerId: pid,
          playerName,
          playerType,
          profilePicture,
          teamName,
          opponentTeam: opponentName,
          wickets,
          runsGiven,
          ballsBowled,
          date: createdAt,
        });
      }
      // 4-wicket hauls => if wickets == 4
      if (wickets === 4) {
        highestFourWicketHauls.push({
          playerId: pid,
          playerName,
          playerType,
          profilePicture,
          teamName,
          opponentTeam: opponentName,
          wickets,
          runsGiven,
          ballsBowled,
          date: createdAt,
        });
      }
      // Centuries => if runs >= 100
      if (runs >= 100) {
        centuries.push({
          playerId: pid,
          playerName,
          playerType,
          profilePicture,
          teamName,
          againstTeam: opponentName,
          runs,
          balls,
          date: createdAt,
        });
      }
      // Half-centuries => if 50 <= runs < 100
      else if (runs >= 50 && runs < 100) {
        halfCenturies.push({
          playerId: pid,
          playerName,
          playerType,
          profilePicture,
          teamName,
          againstTeam: opponentName,
          runs,
          balls,
          date: createdAt,
        });
      }
    });

    // Sort records by achievement value (highest first)
    // 5-wicket hauls: sort by wickets (descending), then by runsGiven (ascending for better economy)
    highestFiveWicketHauls.sort((a, b) => {
      if (b.wickets !== a.wickets) return b.wickets - a.wickets;
      return a.runsGiven - b.runsGiven; // Lower runs given is better
    });

    // 4-wicket hauls: sort by wickets (descending), then by runsGiven (ascending for better economy)
    highestFourWicketHauls.sort((a, b) => {
      if (b.wickets !== a.wickets) return b.wickets - a.wickets;
      return a.runsGiven - b.runsGiven; // Lower runs given is better
    });

    // Centuries: sort by runs (descending), then by balls (ascending for better strike rate)
    centuries.sort((a, b) => {
      if (b.runs !== a.runs) return b.runs - a.runs;
      return a.balls - b.balls; // Fewer balls for same runs is better
    });

    // Half-centuries: sort by runs (descending), then by balls (ascending for better strike rate)
    halfCenturies.sort((a, b) => {
      if (b.runs !== a.runs) return b.runs - a.runs;
      return a.balls - b.balls; // Fewer balls for same runs is better
    });

    // 6) Find overall leading wicket taker & run scorer
    // Build map of player info first (more efficient)
    const playerInfoMap = {};
    filteredStats.forEach((statDoc) => {
      const pid = String(statDoc.playerId._id);
      if (!playerInfoMap[pid]) {
        playerInfoMap[pid] = {
          playerName: statDoc.playerId?.name || 'Unknown Player',
          playerType: statDoc.playerId?.type || null,
          teamName: statDoc.userId?.teamName || 'Unknown Team',
          profilePicture: statDoc.playerId?.profilePicture ?? null,
        };
      }
    });

    // Now find leading run scorer and wicket taker by iterating through unique player IDs
    let leadingWicketTaker = null;
    let maxWickets = 0;

    let leadingRunScorer = null;
    let maxRuns = 0;

    // Iterate through unique player IDs from the maps
    const uniquePlayerIds = new Set([...Object.keys(totalRunsMap), ...Object.keys(totalWicketsMap)]);
    
    for (const pid of uniquePlayerIds) {
      const playerInfo = playerInfoMap[pid];
      if (!playerInfo) continue;

      const runs = totalRunsMap[pid] || 0;
      const wickets = totalWicketsMap[pid] || 0;

      if (runs > maxRuns) {
        maxRuns = runs;
        leadingRunScorer = {
          playerId: pid,
          playerName: playerInfo.playerName,
          playerType: playerInfo.playerType,
          profilePicture: playerInfo.profilePicture ?? null,
          teamName: playerInfo.teamName,
          totalRuns: maxRuns,
        };
      }
      if (wickets > maxWickets) {
        maxWickets = wickets;
        leadingWicketTaker = {
          playerId: pid,
          playerName: playerInfo.playerName,
          playerType: playerInfo.playerType,
          profilePicture: playerInfo.profilePicture ?? null,
          teamName: playerInfo.teamName,
          totalWickets: maxWickets,
        };
      }
    }

    // Count 50s and 100s per player for top run scorers
    const halfCenturyCountMap = {};
    const centuryCountMap = {};
    halfCenturies.forEach(hc => {
      const pid = hc.playerId;
      if (pid) {
        halfCenturyCountMap[pid] = (halfCenturyCountMap[pid] || 0) + 1;
      }
    });
    centuries.forEach(c => {
      const pid = c.playerId;
      if (pid) {
        centuryCountMap[pid] = (centuryCountMap[pid] || 0) + 1;
      }
    });

    // Top 5 run scorers
    const runArray = Object.entries(totalRunsMap).map(([pid, runs]) => {
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        runs,
        halfCenturies: halfCenturyCountMap[pid] || 0,
        centuries: centuryCountMap[pid] || 0,
      };
    });
    runArray.sort((a, b) => b.runs - a.runs);
    const top5RunScorers = runArray.slice(0, 5);

    // Count 4-wicket and 5-wicket hauls per player for top wicket takers
    const fourWicketCountMap = {};
    const fiveWicketCountMap = {};
    highestFourWicketHauls.forEach(h4 => {
      const pid = h4.playerId;
      if (pid) {
        fourWicketCountMap[pid] = (fourWicketCountMap[pid] || 0) + 1;
      }
    });
    highestFiveWicketHauls.forEach(h5 => {
      const pid = h5.playerId;
      if (pid) {
        fiveWicketCountMap[pid] = (fiveWicketCountMap[pid] || 0) + 1;
      }
    });

    // Top 5 wicket takers
    const wicketArray = Object.entries(totalWicketsMap).map(([pid, wickets]) => {
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        wickets,
        fourWicketHauls: fourWicketCountMap[pid] || 0,
        fiveWicketHauls: fiveWicketCountMap[pid] || 0,
      };
    });
    wicketArray.sort((a, b) => b.wickets - a.wickets);
    const top5WicketTakers = wicketArray.slice(0, 5);

    // Top 5 MOM
    const momArray = Object.entries(momCountMap).map(([pid, count]) => {
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
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
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        strikeRate,
      };
    });
    const validBowlingStrikeArray = bowlingStrikeArray.filter(item => item.strikeRate !== Infinity);
    validBowlingStrikeArray.sort((a, b) => a.strikeRate - b.strikeRate);
    const top5BowlingStrikeRate = validBowlingStrikeArray.slice(0, 5);

    // Top 5 Economical Bowlers (lowest economy = best) - min 15 overs (90 balls) bowled
    const economicalBowlersArray = Object.keys(totalBallsBowledMap).map((pid) => {
      const balls = totalBallsBowledMap[pid] || 0;
      const runsGiven = totalRunsGivenMap[pid] || 0;
      let economy = Number.POSITIVE_INFINITY;
      if (balls >= 90) {
        economy = (runsGiven / (balls / 6));
      }
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        economy: parseFloat(economy.toFixed(2)),
        runsGiven,
        ballsBowled: balls,
        wickets: totalWicketsMap[pid] || 0,
      };
    });
    const validEconomicalBowlersArray = economicalBowlersArray.filter(item => item.economy !== Infinity);
    validEconomicalBowlersArray.sort((a, b) => a.economy - b.economy);
    const top5EconomicalBowlers = validEconomicalBowlersArray.slice(0, 5);

    // Top 5 Best Batting Average
    const averageArray = Object.entries(matchCountMap).map(([pid, matchCount]) => {
      const runs = totalRunsMap[pid] || 0;
      // Calculate average as runs per match (since we don't track dismissals)
      const avg = matchCount > 0 ? (runs / matchCount) : 0;
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        matches: matchCount,
        totalRuns: runs,
        average: avg,
      };
    });
    averageArray.sort((a, b) => b.average - a.average);
    const top5BestBattingAverage = averageArray.slice(0, 5);

    const highestTeamTotal = teamTotals.reduce((acc, entry) => {
      if (!acc || entry.runs > acc.runs) return entry;
      return acc;
    }, null);
    const lowestTeamTotal = teamTotals.reduce((acc, entry) => {
      if (!acc || entry.runs < acc.runs) return entry;
      return acc;
    }, null);

    // 7) Construct final response
    const response = {
      highestStrikeRate: highestStrikeRateDoc || {
        playerId: null,
        playerName: '',
        profilePicture: null,
        teamName: '',
        strikeRate: 0,
        opponentTeam: '',
        runs: 0,
        balls: 0,
      },
      bestEconomicalBowler: bestEconomicalBowler || {
        playerId: null,
        playerName: '',
        profilePicture: null,
        teamName: '',
        economy: 0,
        opponentTeam: '',
        wickets: 0,
        runsGiven: 0,
        ballsBowled: 0,
      },
      highestWicketTakerInMatch: highestWicketsDoc || {
        playerId: null,
        playerName: '',
        profilePicture: null,
        teamName: '',
        wickets: 0,
        opponentTeam: '',
        runsGiven: 0,
        ballsBowled: 0,
      },
      highestScore: highestScoreDoc || {
        playerId: null,
        playerName: '',
        profilePicture: null,
        teamName: '',
        opponentTeam: '',
        score: 0,
        balls: 0,
        strikeRate: 0,
      },
      leadingWicketTaker: leadingWicketTaker || {
        playerId: null,
        playerName: '',
        profilePicture: null,
        teamName: '',
        totalWickets: 0,
      },
      leadingRunScorer: leadingRunScorer || {
        playerId: null,
        playerName: '',
        profilePicture: null,
        teamName: '',
        totalRuns: 0,
      },
      highestTeamTotal: highestTeamTotal || {
        teamName: '',
        opponentTeam: '',
        runs: 0,
        overs: 0,
        wickets: 0,
      },
      lowestTeamTotal: lowestTeamTotal || {
        teamName: '',
        opponentTeam: '',
        runs: 0,
        overs: 0,
        wickets: 0,
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
      top5EconomicalBowlers,
      top5BestBattingAverage,
    };

    // 🚀 PERFORMANCE: Cache the response for 5 minutes (skip when nocache=1)
    if (!skipCache) {
      cache.set(cacheKey, response, 300);
    }
    // Prevent CDN/proxy caching when nocache - ensures cloud returns fresh data
    if (skipCache) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.set('Pragma', 'no-cache');
    }
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
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const stats = await PlayerStats.find({ playerId })
      .populate({
        path: 'opponentUserId',
        model: User,
        select: 'teamName'
      })
      .sort({ createdAt: 1 })
      .lean();

    // Calculate totals and averages
    let totalRuns = 0;
    let totalBalls = 0;
    let totalWickets = 0;
    let totalRunsGiven = 0;
    let totalBallsBowled = 0;
    let momCount = 0;
    let matchCount = stats.length;
    let halfCenturyCount = 0;
    let centuryCount = 0;
    let fourWicketHaulCount = 0;
    let fiveWicketHaulCount = 0;

    // Helper functions
    const calcStrikeRate = (runs, balls) => {
      // Minimum 10 balls required for realistic strike rate calculation
      if (!balls || balls < 10) return 0;
      return (runs / balls) * 100;
    };

    const calcEconomy = (runsGiven, ballsBowled, wickets = 0) => {
      // Minimum 12 balls (2 overs) AND at least 1 wicket required for realistic economy calculation
      if (!ballsBowled || ballsBowled < 12 || wickets < 1) return 0;
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
      
      // Count 50s and 100s
      if (runs >= 100) {
        centuryCount++;
      } else if (runs >= 50 && runs < 100) {
        halfCenturyCount++;
      }
      
      // Count 4-wicket and 5-wicket hauls
      if (wickets >= 5) {
        fiveWicketHaulCount++;
      } else if (wickets === 4) {
        fourWicketHaulCount++;
      }

      const economy = ballsBowled > 0 ? (runsGiven / (ballsBowled / 6)) : null;
      const hasValidEconomy = ballsBowled > 0;
      return {
        matchNumber: index + 1,
        date: stat.createdAt,
        teamName: ownerUser.teamName,
        opponentTeam: stat.opponentUserId?.teamName || 'Unknown Team',
        runs: runs,
        balls: balls,
        wickets: wickets,
        runsGiven: runsGiven,
        ballsBowled: ballsBowled,
        economy: hasValidEconomy ? parseFloat(economy.toFixed(2)) : null,
        isMom: stat.isMom || false
      };
    });

    // Calculate averages
    const average = matchCount > 0 ? totalRuns / matchCount : 0;
    const strikeRate = calcStrikeRate(totalRuns, totalBalls);
    const economy = calcEconomy(totalRunsGiven, totalBallsBowled, totalWickets);
    const bowlingStrikeRate = calcBowlingStrikeRate(totalBallsBowled, totalWickets);

    // Determine if this is batting or bowling focused
    const isBattingFocused = totalRuns > totalWickets * 10; // Simple heuristic

    const response = {
      playerName: player.name,
      profilePicture: player.profilePicture || null,
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
      matchHistory: matchHistory,
      halfCenturies: halfCenturyCount,
      centuries: centuryCount,
      fourWicketHauls: fourWicketHaulCount,
      fiveWicketHauls: fiveWicketHaulCount
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



