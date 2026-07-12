const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const axios = require('axios');
const NodeCache = require('node-cache');
const PlayerStats = require('../models/PlayerStats'); // Adjust the path as needed
const Player = require('../models/Player'); // Adjust the path
const User = require('../models/User'); // Adjust the path
const UserPlayer = require('../models/UserPlayer'); // Adjust the path
const MatchResult = require('../models/MatchResult');
const Fixture = require('../models/Fixture');
const Tournament = require('../models/Tournament');
const VenueMatchEntry = require('../models/VenueMatchEntry');
const {
  cacheConfig,
  invalidateCache,
  registerExtraCache,
  clearAllCaches,
  registerStatsOverviewInvalidator,
} = require('../utils/cache');
const { upsertLiveCareerSummaryForPlayer } = require('../utils/playerCareerSummary');
const {
  buildCurrentOwnerTeamByPlayerId,
  findCurrentOwnerUser,
  resolveTeamNameFromOwnerMap,
} = require('../utils/currentPlayerOwner');
const { invalidateCareerSummaryCache } = require('../utils/cplReadCaches');
const venueInsights = require('../utils/venueInsights');
const {
  getGroupedPlayerTeamTournamentHistory,
  rebuildPlayerTeamTournamentStat,
  syncPlayerTeamTournamentStatFromPlayerStats,
} = require('../utils/playerTeamTournamentStats');

// 🚀 PERFORMANCE: Create cache instance (5 minute TTL for stats) - keeping for backward compatibility
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
registerExtraCache(cache);
registerStatsOverviewInvalidator(() => cache.del('stats-overview'));

/** Heavy venue analytics (aggregate + explorer) — short TTL, flushed on ledger / stats saves. */
const venueAnalyticsCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });
registerExtraCache(venueAnalyticsCache);

const stableVenueCacheKeyFromQuery = (req) => {
  const q = req.query || {};
  const keys = Object.keys(q)
    .filter((k) => k !== 'nocache')
    .sort();
  return keys.map((k) => `${k}=${String(q[k] ?? '')}`).join('&');
};
// Load list of players with playerId and userId

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundNumber = (value = 0, digits = 2) => Number.parseFloat((value || 0).toFixed(digits));
const countDismissals = (innings = 0, notOutInnings = 0) =>
  Math.max(0, (Number(innings) || 0) - (Number(notOutInnings) || 0));
const battingAverageFromTotals = (runs = 0, innings = 0, notOutInnings = 0) => {
  const dismissals = countDismissals(innings, notOutInnings);
  if (dismissals > 0) return runs / dismissals;
  return runs > 0 ? runs : 0;
};

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
      const notOut = stat.battingStats?.notOut ? 1 : 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;

      acc.battingRuns += runs;
      acc.battingBalls += balls;
      acc.notOutInnings += notOut;
      acc.wickets += wickets;
      acc.runsGiven += runsGiven;
      acc.ballsBowled += ballsBowled;

      return acc;
    },
    { battingRuns: 0, battingBalls: 0, notOutInnings: 0, wickets: 0, runsGiven: 0, ballsBowled: 0 }
  );

  const lastFiveTotals = lastFive.reduce(
    (acc, stat) => {
      const runs = stat.battingStats?.runs || 0;
      const balls = stat.battingStats?.balls || 0;
      const notOut = stat.battingStats?.notOut ? 1 : 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;

      acc.battingRuns += runs;
      acc.battingBalls += balls;
      acc.notOutInnings += notOut;
      acc.wickets += wickets;
      acc.runsGiven += runsGiven;
      acc.ballsBowled += ballsBowled;

      return acc;
    },
    { battingRuns: 0, battingBalls: 0, notOutInnings: 0, wickets: 0, runsGiven: 0, ballsBowled: 0 }
  );

  const recentAvg = lastFive.length
    ? battingAverageFromTotals(lastFiveTotals.battingRuns, lastFive.length, lastFiveTotals.notOutInnings)
    : 0;
  const recentStrikeRate =
    lastFiveTotals.battingBalls >= 10
      ? (lastFiveTotals.battingRuns / lastFiveTotals.battingBalls) * 100
      : 0;

  const overallAvg = matchCount > 0
    ? battingAverageFromTotals(totals.battingRuns, matchCount, totals.notOutInnings)
    : 0;
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

  const ownerUser = await findCurrentOwnerUser(playerId);

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
  await upsertLiveCareerSummaryForPlayer(playerId);
};

const resolvePlayerOwner = async (playerId) => {
  if (!playerId) return null;

  const rosterEntry = await UserPlayer.findOne({ playerId, isActive: true })
    .select('userId')
    .lean();

  let ownerUser = rosterEntry?.userId
    ? await User.findById(rosterEntry.userId).select('_id teamName isAdmin').lean()
    : null;

  if (!ownerUser) {
    ownerUser = await User.findOne({ boughtPlayers: playerId })
      .select('_id teamName isAdmin')
      .lean();
  }

  return ownerUser;
};

const assertCanEditPlayerStats = async (requestedByUserId, playerId) => {
  const ownerUser = await resolvePlayerOwner(playerId);
  if (!ownerUser) {
    const error = new Error('No user found who owns this player');
    error.status = 400;
    throw error;
  }

  if (!requestedByUserId) {
    return ownerUser;
  }

  const requester = await User.findById(requestedByUserId).select('_id isAdmin').lean();
  if (!requester) {
    const error = new Error('Requesting user not found');
    error.status = 403;
    throw error;
  }

  if (requester.isAdmin || String(requester._id) === String(ownerUser._id)) {
    return ownerUser;
  }

  const error = new Error('Only the player owner or an admin can update these stats');
  error.status = 403;
  throw error;
};

const normalizeOpponentUserId = async (rawOpponentUserId, opponentTeamName) => {
  if (rawOpponentUserId && mongoose.Types.ObjectId.isValid(String(rawOpponentUserId))) {
    return rawOpponentUserId;
  }
  const name = (opponentTeamName || rawOpponentUserId || '').trim();
  if (!name) return null;
  const regex = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const opponent = await User.findOne({ teamName: regex, isAdmin: false }).select('_id').lean();
  return opponent?._id || null;
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
    notOut = 0,
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
  if (notOut !== undefined && notOut !== null && notOut !== 0) inc.totalNotOutInnings = notOut;

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

const syncCareerAndRankingAfterStatChange = async (playerId, deltaTotals, contextLabel = 'stats-save') => {
  await applyPlayerStatDelta(playerId, deltaTotals);
  await upsertLiveCareerSummaryForPlayer(playerId);
  invalidateCareerSummaryCache();
  console.log(`✅ Career + rankings synced after ${contextLabel} for player ${playerId}`);
};

const VALID_WC_STAGES = ['super8', 'semi', 'final'];
const normalizeWcStage = (stage) => {
  if (typeof stage !== 'string') return null;
  const trimmed = stage.trim().toLowerCase();
  return VALID_WC_STAGES.includes(trimmed) ? trimmed : null;
};

const normalizeMatchWinnerSide = (v) => (v === 'home' || v === 'away' ? v : null);

const resolveStatsTeamUserId = async (rawUserId, fallbackUserId) => {
  const candidate = rawUserId || fallbackUserId;
  if (!candidate) return fallbackUserId;
  const user = await User.findById(candidate).select('_id').lean();
  return user?._id || fallbackUserId;
};

/**
 * Mirror a saved PlayerStats row into the persistent VenueMatchEntry
 * ledger. Keyed on `sourcePlayerStatsId` so re-saves of the same row
 * within the current season overwrite (no duplicates), but the entry
 * survives any future PlayerStats wipe.
 *
 * Best-effort — logs and swallows errors so a ledger glitch never
 * blocks the primary stats save.
 */
/**
 * Minimal venue ledger row. We deliberately keep this tight — only
 * fields that /venue-aggregate (or future per-venue analytics) will
 * actually read. Anything cosmetic (matchName, matchKey, isMom, fours/
 * sixes) lives on PlayerStats while the season is active and is not
 * mirrored here.
 */
const upsertVenueMatchEntry = async (
  playerStatsDoc,
  { matchId } = {}
) => {
  try {
    if (!playerStatsDoc) return;
    const venueRaw = playerStatsDoc.venue;
    const venue = typeof venueRaw === 'string' ? venueRaw.trim() : '';
    if (!venue) return; // No venue → nothing to ledger.

    const meta = playerStatsDoc.metadata || {};

    await VenueMatchEntry.findOneAndUpdate(
      { sourcePlayerStatsId: playerStatsDoc._id },
      {
        $set: {
          playerId: playerStatsDoc.playerId,
          userId: playerStatsDoc.userId,
          opponentUserId: playerStatsDoc.opponentUserId || null,
          venue,
          tournamentId: playerStatsDoc.tournamentId || null,
          matchId: matchId || null,
          isPlayoffScore: !!meta.isPlayoffScore,
          isWcScore: !!meta.isWcScore,
          isMom: !!playerStatsDoc.isMom,
          wcStage: meta.wcStage || null,
          battingStats: {
            runs: playerStatsDoc.battingStats?.runs || 0,
            balls: playerStatsDoc.battingStats?.balls || 0,
            notOut: !!playerStatsDoc.battingStats?.notOut,
          },
          bowlingStats: {
            runsGiven: playerStatsDoc.bowlingStats?.runsGiven || 0,
            ballsBowled: playerStatsDoc.bowlingStats?.ballsBowled || 0,
            wickets: playerStatsDoc.bowlingStats?.wickets || 0,
          },
          sourcePlayerStatsId: playerStatsDoc._id,
          teamInningsOrder:
            playerStatsDoc.teamInningsOrder === 1 || playerStatsDoc.teamInningsOrder === 2
              ? playerStatsDoc.teamInningsOrder
              : null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error('⚠️ Failed to upsert VenueMatchEntry (non-fatal):', err.message);
  }
};

const savePlayerStatsEntry = async (payload = {}) => {
  const {
    playerId,
    opponentUserId: rawOpponentUserId,
    battingStats,
    bowlingStats,
    wicketsTaken,
    isMom,
    isPlayoffScore,
    isWcScore,
    wcStage: rawWcStage,
    tournamentId: rawTournamentId,
    venue: rawVenue,
    economy,
    extras,
    matchKey,
    matchName,
    matchId,
    teamInningsOrder: rawTeamInningsOrder,
    matchWinnerSide: rawMatchWinnerSide,
    forceCreate: rawForceCreate,
    existingStatsId: rawExistingStatsId,
    playerStatsId: rawPlayerStatsId,
    requestedByUserId: rawRequestedByUserId,
    opponentTeamName,
  } = payload;

  const venue = typeof rawVenue === 'string' ? rawVenue.trim() : rawVenue || null;
  const normalizedTeamInningsOrder =
    rawTeamInningsOrder === 1 || rawTeamInningsOrder === 2 ? rawTeamInningsOrder : null;

  if (!playerId) {
    const error = new Error('playerId is required');
    error.status = 400;
    throw error;
  }

  const ownerUser = await assertCanEditPlayerStats(
    rawRequestedByUserId,
    playerId
  );
  const userId = await resolveStatsTeamUserId(payload.userId, ownerUser._id);
  const opponentUserId = await normalizeOpponentUserId(
    rawOpponentUserId,
    opponentTeamName
  );
  const wcStage = isWcScore ? normalizeWcStage(rawWcStage) : null;
  const tournamentId = rawTournamentId || null;
  const forceCreate = rawForceCreate === true || rawForceCreate === 'true';
  const existingStatsId = rawExistingStatsId || rawPlayerStatsId || null;

  if (isWcScore && !wcStage) {
    const error = new Error('wcStage is required when isWcScore is true (super8 | semi | final)');
    error.status = 400;
    throw error;
  }

  // Decide what existing entry (if any) to overwrite.
  // - existingStatsId: explicit edit from player-stats UI (works for regular, playoff, WC)
  // - WC entries: bucketed by (player, owner, opponent, tournamentId, wcStage)
  // - Regular entries: dedup on (player, owner, opponent), excluding WC/playoff buckets
  // - Playoff entries without existingStatsId always create new
  // - forceCreate=true bypasses overwrite lookup and always creates a fresh row
  let existingStats = null;
  if (!forceCreate) {
    if (existingStatsId) {
      existingStats = await PlayerStats.findById(existingStatsId);
      if (!existingStats) {
        const error = new Error('Existing stats entry not found');
        error.status = 404;
        throw error;
      }
      if (String(existingStats.playerId) !== String(playerId)) {
        const error = new Error('Existing stats entry does not belong to this player');
        error.status = 400;
        throw error;
      }
    } else if (isWcScore) {
      existingStats = await PlayerStats.findOne({
        playerId,
        userId,
        opponentUserId,
        tournamentId,
        'metadata.isWcScore': true,
        'metadata.wcStage': wcStage,
      });
    } else if (isPlayoffScore && opponentUserId) {
      existingStats = await PlayerStats.findOne({
        playerId,
        userId,
        opponentUserId,
        'metadata.isPlayoffScore': true,
      }).sort({ createdAt: -1 });
    } else if (!isPlayoffScore) {
      existingStats = await PlayerStats.findOne({
        playerId,
        userId,
        opponentUserId,
        $and: [
          { $or: [{ 'metadata.isWcScore': { $ne: true } }, { 'metadata.isWcScore': { $exists: false } }] },
          { $or: [{ 'metadata.isPlayoffScore': { $ne: true } }, { 'metadata.isPlayoffScore': { $exists: false } }] },
        ],
      });
      if (!existingStats && payload.userId && (matchId || matchKey || matchName)) {
        existingStats = await PlayerStats.findOne({
          playerId,
          opponentUserId,
          $and: [
            { $or: [{ 'metadata.isWcScore': { $ne: true } }, { 'metadata.isWcScore': { $exists: false } }] },
            { $or: [{ 'metadata.isPlayoffScore': { $ne: true } }, { 'metadata.isPlayoffScore': { $exists: false } }] },
          ],
        }).sort({ createdAt: -1 });
      }
    }
  }

  const newTotals = {
    runs: battingStats?.runs || 0,
    balls: battingStats?.balls || 0,
    notOut: battingStats?.notOut ? 1 : 0,
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
    notOut: 0,
  };

  if (existingStats) {
    const previousTeamId = existingStats.userId || null;
    const previousTournamentId = existingStats.tournamentId || null;
    const previousTotals = {
      runs: existingStats.battingStats?.runs || 0,
      balls: existingStats.battingStats?.balls || 0,
      notOut: existingStats.battingStats?.notOut ? 1 : 0,
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
    deltaTotals.notOut = newTotals.notOut - previousTotals.notOut;

    existingStats.battingStats = {
      runs: battingStats?.runs || 0,
      balls: battingStats?.balls || 0,
      notOut: !!battingStats?.notOut,
    };

    existingStats.bowlingStats = {
      runsGiven: bowlingStats?.runsGiven || 0,
      ballsBowled: bowlingStats?.ballsBowled || 0,
      wickets: wicketsTaken !== undefined && wicketsTaken !== null ? wicketsTaken : (bowlingStats?.wickets || 0),
    };

    existingStats.isMom = !!isMom;
    existingStats.userId = userId;
    if (opponentUserId) {
      existingStats.opponentUserId = opponentUserId;
    }
    
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
    if (isWcScore !== null && isWcScore !== undefined) {
      existingStats.metadata.isWcScore = !!isWcScore;
    }
    if (isWcScore) {
      existingStats.metadata.wcStage = wcStage;
      existingStats.tournamentId = tournamentId;
    }
    if (venue) {
      existingStats.venue = venue;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'teamInningsOrder')) {
      existingStats.teamInningsOrder = normalizedTeamInningsOrder;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'matchWinnerSide')) {
      existingStats.metadata.matchWinnerSide = normalizeMatchWinnerSide(rawMatchWinnerSide);
    }

    await existingStats.save();
    
    const hasStatChanges = Object.values(deltaTotals).some((v) => v !== 0);

    console.log(`📊 Updating player ${playerId} totals with delta:`, deltaTotals);
    await syncCareerAndRankingAfterStatChange(playerId, deltaTotals, 'single-update');

    // 🚀 PERFORMANCE: Invalidate stats-overview and players data cache when stats are updated
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data'); // Invalidate top rankings cache

    // Mirror to persistent venue ledger (survives PlayerStats wipes).
    await upsertVenueMatchEntry(existingStats, { matchId });
    await syncPlayerTeamTournamentStatFromPlayerStats(existingStats);
    if (previousTeamId && String(previousTeamId) !== String(userId)) {
      await rebuildPlayerTeamTournamentStat({
        teamId: previousTeamId,
        playerId,
        tournamentId: previousTournamentId || null,
      });
    }

    return {
      action: 'updated',
      doc: existingStats,
      noChanges: !hasStatChanges,
      message: hasStatChanges
        ? 'Player stats updated successfully'
        : 'No changes detected — values saved match what was already stored',
    };
  }

  deltaTotals.runs = newTotals.runs;
  deltaTotals.balls = newTotals.balls;
  deltaTotals.runsGiven = newTotals.runsGiven;
  deltaTotals.ballsBowled = newTotals.ballsBowled;
  deltaTotals.wickets = newTotals.wickets;
  deltaTotals.mom = newTotals.mom;
  deltaTotals.matches = 1;
  deltaTotals.notOut = newTotals.notOut;

  const newStats = new PlayerStats({
    playerId,
    userId,
    opponentUserId,
    tournamentId: isWcScore ? tournamentId : null,
    venue: venue || null,
    teamInningsOrder: normalizedTeamInningsOrder,
    battingStats: {
      runs: battingStats?.runs || 0,
      balls: battingStats?.balls || 0,
      notOut: !!battingStats?.notOut,
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
      isWcScore: !!isWcScore,
      wcStage: isWcScore ? wcStage : null,
      matchWinnerSide: normalizeMatchWinnerSide(rawMatchWinnerSide),
    },
  });

    await newStats.save();
    
    console.log(`📊 Adding new stats for player ${playerId} with delta:`, deltaTotals);
    await syncCareerAndRankingAfterStatChange(playerId, deltaTotals, 'single-create');

    // 🚀 PERFORMANCE: Invalidate stats-overview and players data cache when new stats are added
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data'); // Invalidate top rankings cache

    // Mirror to persistent venue ledger (survives PlayerStats wipes).
    await upsertVenueMatchEntry(newStats, { matchId });
    await syncPlayerTeamTournamentStatFromPlayerStats(newStats);

    return { action: 'created', doc: newStats };
};

router.get('/list', async (req, res) => {
  // 🚀 PERFORMANCE: Check cache first (2 minute cache for player stats list)
  const { userId } = req.query;
  const skipCache =
    req.query.nocache === '1' ||
    req.query.nocache === 'true' ||
    req.query.nocache === 'yes';
  const cacheKey = `player-stats-list:${userId}`;
  if (!skipCache) {
    const cached = cacheConfig.medium.get(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }
  }

  try {

    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const user = await User.findById(userId)
      .select('_id teamName isAdmin isTournamentReady')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isAdmin = user.isAdmin;

    // Non-admin users must be tournament ready; admins can always manage stats
    if (!isAdmin && !user.isTournamentReady) {
      return res.status(403).json({ message: 'User is not tournament ready' });
    }
    let playersToSend = [];

    // Helper function to convert balls into overs (X.Y format)
    const convertBallsToOvers = (balls) => {
      const b = balls || 0;
      const overs = Math.floor(b / 6);
      const remainder = b % 6;
      return `${overs}.${remainder}`;
    };

    // 🚀 PERFORMANCE: Run queries in parallel for faster execution
    const playerSelect =
      '_id name type role basePrice style overallScore profilePicture isSold isActive';

    const [playersResult, playoffTeamsResult] = await Promise.all([
      // Admin: all sold players. Team owners: active roster only (UserPlayer, not stale boughtPlayers).
      isAdmin
        ? Player.find({ isSold: true, isActive: true }, playerSelect).lean()
        : UserPlayer.find({ userId, isActive: true })
            .populate('playerId', playerSelect)
            .lean()
            .then((rows) =>
              rows
                .map((row) => row.playerId)
                .filter((player) => player && player.isSold && player.isActive)
            ),
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

    const allPlayerIds = playersToSend.map(p => p._id);

    // Map each player to their owning team (needed when admin views all players)
    const ownerByPlayerId = new Map();
    if (isAdmin && allPlayerIds.length > 0) {
      const [rosterRows, ownerUsersFromBought] = await Promise.all([
        UserPlayer.find({ playerId: { $in: allPlayerIds }, isActive: true })
          .select('playerId userId')
          .lean(),
        User.find({ boughtPlayers: { $in: allPlayerIds } })
          .select('_id teamName boughtPlayers')
          .lean(),
      ]);

      rosterRows.forEach((row) => {
        ownerByPlayerId.set(String(row.playerId), { ownerUserId: row.userId });
      });

      ownerUsersFromBought.forEach((owner) => {
        (owner.boughtPlayers || []).forEach((pid) => {
          const key = String(pid);
          if (allPlayerIds.some((id) => String(id) === key) && !ownerByPlayerId.has(key)) {
            ownerByPlayerId.set(key, { ownerUserId: owner._id });
          }
        });
      });

      const ownerUserIds = [
        ...new Set(
          [...ownerByPlayerId.values()]
            .map((entry) => entry.ownerUserId)
            .filter(Boolean)
            .map(String)
        ),
      ];
      const ownerUsers = ownerUserIds.length
        ? await User.find({ _id: { $in: ownerUserIds } }).select('_id teamName').lean()
        : [];
      const ownerTeamByUserId = new Map(
        ownerUsers.map((owner) => [String(owner._id), owner.teamName || 'Unknown'])
      );

      ownerByPlayerId.forEach((entry, playerKey) => {
        entry.ownerTeamName = ownerTeamByUserId.get(String(entry.ownerUserId)) || 'Unknown';
        ownerByPlayerId.set(playerKey, entry);
      });
    }

    // 🚀 PERFORMANCE: Batch fetch all PlayerStats for all players at once (instead of N queries)
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
        statId: stat._id,
        opponentUserId: stat.opponentUserId || null,
        match: stat.matchName,
        runs: stat.battingStats?.runs || 0,
        balls: stat.battingStats?.balls || 0,
        notOut: !!stat.battingStats?.notOut,
        mom: stat.isMom || false,
        // Use pre-fetched opponent map (no database query)
        against: stat.opponentUserId 
          ? (opponentMap[String(stat.opponentUserId)] || 'Unknown')
          : 'Unknown'
      }));

      // Calculate bowling performance per match (using pre-fetched opponent data)
      const bowlingStats = stats.map((stat) => ({
        statId: stat._id,
        opponentUserId: stat.opponentUserId || null,
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
      
      const ownerInfo = isAdmin ? ownerByPlayerId.get(String(player._id)) : null;

      return {
        _id: player._id,
        name: player.name,
        type: player.type,
        role: player.role,
        team: isAdmin ? (ownerInfo?.ownerTeamName || 'Unknown') : user.teamName,
        ownerUserId: isAdmin ? ownerInfo?.ownerUserId || null : user._id,
        ownerTeamName: isAdmin ? ownerInfo?.ownerTeamName || 'Unknown' : user.teamName,
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
        message: result.message || 'Player stats updated successfully',
        noChanges: !!result.noChanges,
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
    invalidateCache('player-stats-list');
    invalidateCache('players:data'); // Invalidate top rankings cache
    venueAnalyticsCache.flushAll();
  }
});

router.get('/team-tournament-history', async (req, res) => {
  try {
    const history = await getGroupedPlayerTeamTournamentHistory({
      playerId: req.query.playerId || null,
    });
    res.json({ players: history });
  } catch (error) {
    console.error('Error fetching player team tournament history:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch history' });
  }
});

function summarizeWcPlayerForSpotlight(p) {
  if (!p) return null;
  return {
    playerId: p.playerId,
    name: p.name,
    profilePicture: p.profilePicture || null,
    runs: p.totals.runs || 0,
    wickets: p.totals.wickets || 0,
    mom: p.totals.mom || 0,
    matches: p.totals.matches || 0,
  };
}

function computeWcTeamSpotlights(teamPlayers) {
  if (!teamPlayers.length) {
    return {
      topRuns: null,
      topWickets: null,
      topMom: null,
      topAllRounder: null,
    };
  }
  const byRuns = [...teamPlayers].sort(
    (a, b) =>
      (b.totals.runs || 0) - (a.totals.runs || 0) ||
      (b.totals.balls || 0) - (a.totals.balls || 0)
  );
  const byWickets = [...teamPlayers].sort(
    (a, b) =>
      (b.totals.wickets || 0) - (a.totals.wickets || 0) ||
      (b.totals.runsGiven || 0) - (a.totals.runsGiven || 0)
  );
  const byMom = [...teamPlayers].sort(
    (a, b) =>
      (b.totals.mom || 0) - (a.totals.mom || 0) ||
      (b.totals.runs || 0) - (a.totals.runs || 0)
  );
  const arScore = (p) => (p.totals.runs || 0) + 20 * (p.totals.wickets || 0);
  const arQualified = teamPlayers.filter(
    (p) => (p.totals.runs || 0) >= 10 && (p.totals.wickets || 0) >= 1
  );
  const topAR = arQualified.length
    ? [...arQualified].sort((a, b) => arScore(b) - arScore(a))[0]
    : null;

  return {
    topRuns: summarizeWcPlayerForSpotlight(
      byRuns[0] && (byRuns[0].totals.runs || 0) > 0 ? byRuns[0] : null
    ),
    topWickets: summarizeWcPlayerForSpotlight(
      byWickets[0] && (byWickets[0].totals.wickets || 0) > 0 ? byWickets[0] : null
    ),
    topMom: summarizeWcPlayerForSpotlight(
      byMom[0] && (byMom[0].totals.mom || 0) > 0 ? byMom[0] : null
    ),
    topAllRounder: summarizeWcPlayerForSpotlight(topAR),
  };
}

function ledgerRowsToWcStylePlayers(rawRows, nameById, picById) {
  return rawRows.map((r) => ({
    playerId: String(r.playerId),
    name: nameById.get(String(r.playerId)) || 'Player',
    profilePicture: picById.get(String(r.playerId)) || null,
    team: null,
    role: null,
    type: null,
    totals: {
      runs: r.runs || 0,
      balls: r.balls || 0,
      wickets: r.wickets || 0,
      runsGiven: r.runsGiven || 0,
      ballsBowled: r.ballsBowled || 0,
      mom: r.mom || 0,
      matches: r.appearances || 0,
    },
    matches: [],
  }));
}

function buildVenueSpotlightsFromLedgerGroups(venuePlayerAggRows, nameById, picById) {
  const byVenue = new Map();
  for (const row of venuePlayerAggRows) {
    const v = row._id?.venue;
    const pid = row._id?.playerId;
    if (!v || !pid) continue;
    if (!byVenue.has(v)) byVenue.set(v, []);
    byVenue.get(v).push({
      playerId: pid,
      runs: row.runs || 0,
      balls: row.balls || 0,
      wickets: row.wickets || 0,
      runsGiven: row.runsGiven || 0,
      ballsBowled: row.ballsBowled || 0,
      mom: row.mom || 0,
      appearances: row.appearances || 0,
    });
  }
  const spotlightsByVenue = new Map();
  for (const [v, rows] of byVenue) {
    const fakePlayers = ledgerRowsToWcStylePlayers(rows, nameById, picById);
    spotlightsByVenue.set(v, computeWcTeamSpotlights(fakePlayers));
  }
  return spotlightsByVenue;
}

// GET /api/player-stats/venue-aggregate
// Optional query: ?playerId=...&userId=...&tournamentId=...&venue=...&scope=league|all
// Returns aggregated batting/bowling totals grouped by venue, plus per-match breakdowns.
// Useful for showing "at this venue, this many runs scored / this many wickets fallen".
//
// Response fields per venue row:
//   - `matches` — distinct games (matchId cardinality).
//   - `teamInnings` — T20 convention: 2 × matches (both sides bat once).
//   - `playerRows` — number of ledger lines (≈ XI per side); legacy key `innings` = same.
//   - `spotlights` — per venue: topRuns, topWickets, topMom, topAllRounder (from ledger; MoM needs isMom on ledger rows).
//   - `players` — when `userId` is passed (squad view), or when `venue` + `includeVenuePlayers=1` (full roster cap 120).
//
// IMPORTANT: this aggregate reads from the persistent VenueMatchEntry
// ledger (NOT PlayerStats). PlayerStats is wiped at the end of every
// tournament — the ledger isn't, so venue analytics survive resets.
//
// scope:
//   - 'league' (default when nothing tournament-specific is passed): only regular
//     league matches — excludes any entry tagged isWcScore, isPlayoffScore, or
//     belonging to a tournament.
//   - 'all'   : every entry that has a venue, regardless of category.
router.get('/venue-aggregate', async (req, res) => {
  try {
    const bustCache =
      req.query.nocache === '1' ||
      req.query.nocache === 'true' ||
      req.query.nocache === 'yes';
    const venueAggCacheKey = `vagg:${stableVenueCacheKeyFromQuery(req)}`;
    if (!bustCache) {
      const cachedAgg = venueAnalyticsCache.get(venueAggCacheKey);
      if (cachedAgg) return res.status(200).json(cachedAgg);
    }

    const { playerId, userId, tournamentId, venue, scope } = req.query;

    // Source of truth is the persistent VenueMatchEntry ledger — it
    // survives PlayerStats wipes (which happen at end-of-tournament),
    // so historical venue analytics keep working across seasons.
    const match = { venue: { $nin: [null, ''] } };
    if (playerId) match.playerId = new mongoose.Types.ObjectId(playerId);
    if (userId) match.userId = new mongoose.Types.ObjectId(userId);
    if (tournamentId) match.tournamentId = new mongoose.Types.ObjectId(tournamentId);
    if (venue) match.venue = venue;

    const wantLeagueOnly = scope === 'league' || (!scope && !tournamentId);
    if (wantLeagueOnly) {
      match.$and = [
        { isWcScore: { $ne: true } },
        { isPlayoffScore: { $ne: true } },
        { $or: [{ tournamentId: null }, { tournamentId: { $exists: false } }] },
      ];
    }

    const includeVenuePlayers =
      req.query.includeVenuePlayers === '1' ||
      req.query.includeVenuePlayers === 'true';

    const [facetResult] = await VenueMatchEntry.aggregate([
      { $match: match },
      {
        $facet: {
          byVenue: [
            {
              $addFields: {
                _matchKeyForCount: {
                  $ifNull: ['$matchId', { $toString: '$_id' }],
                },
              },
            },
            {
              $group: {
                _id: '$venue',
                innings: { $sum: 1 },
                matchSet: { $addToSet: '$_matchKeyForCount' },
                totalRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
                totalBalls: { $sum: { $ifNull: ['$battingStats.balls', 0] } },
                totalWicketsTaken: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
                totalRunsGiven: { $sum: { $ifNull: ['$bowlingStats.runsGiven', 0] } },
                totalBallsBowled: { $sum: { $ifNull: ['$bowlingStats.ballsBowled', 0] } },
              },
            },
            {
              $addFields: {
                matches: { $size: '$matchSet' },
              },
            },
            { $project: { matchSet: 0 } },
            { $sort: { matches: -1, _id: 1 } },
          ],
          byVenuePlayer: [
            {
              $group: {
                _id: { venue: '$venue', playerId: '$playerId' },
                runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
                balls: { $sum: { $ifNull: ['$battingStats.balls', 0] } },
                wickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
                runsGiven: { $sum: { $ifNull: ['$bowlingStats.runsGiven', 0] } },
                ballsBowled: { $sum: { $ifNull: ['$bowlingStats.ballsBowled', 0] } },
                mom: { $sum: { $cond: [{ $eq: ['$isMom', true] }, 1, 0] } },
                appearances: { $sum: 1 },
              },
            },
          ],
        },
      },
    ]);

    const grouped = facetResult.byVenue || [];
    const venuePlayerAggRows = facetResult.byVenuePlayer || [];

    const pidSetLedger = new Set();
    for (const row of venuePlayerAggRows) {
      const pid = row._id?.playerId;
      if (pid && mongoose.Types.ObjectId.isValid(String(pid))) {
        pidSetLedger.add(String(pid));
      }
    }
    const pidListLedger = [...pidSetLedger].map((id) => new mongoose.Types.ObjectId(id));
    const playerDocsLedger =
      pidListLedger.length > 0
        ? await Player.find({ _id: { $in: pidListLedger } }).select('name profilePicture').lean()
        : [];
    const nameByIdLedger = new Map(playerDocsLedger.map((p) => [String(p._id), p.name || 'Player']));
    const picByIdLedger = new Map(
      playerDocsLedger.map((p) => [String(p._id), p.profilePicture || null])
    );

    const spotlightsByVenue = buildVenueSpotlightsFromLedgerGroups(
      venuePlayerAggRows,
      nameByIdLedger,
      picByIdLedger
    );

    const venues = grouped.map((row) => {
      const matches = row.matches || 0;
      const playerRows = row.innings || 0;
      const vName = row._id;
      const spotlights = spotlightsByVenue.get(vName) || {
        topRuns: null,
        topWickets: null,
        topMom: null,
        topAllRounder: null,
      };
      return {
        venue: vName,
        matches,
        playerRows,
        /** @deprecated use `playerRows` — kept for older clients */
        innings: playerRows,
        teamInnings: matches * 2,
        batting: {
          runs: row.totalRuns,
          balls: row.totalBalls,
          strikeRate: row.totalBalls
            ? Number(((row.totalRuns / row.totalBalls) * 100).toFixed(2))
            : 0,
        },
        bowling: {
          wickets: row.totalWicketsTaken,
          runsGiven: row.totalRunsGiven,
          ballsBowled: row.totalBallsBowled,
          economy: row.totalBallsBowled
            ? Number(((row.totalRunsGiven / (row.totalBallsBowled / 6))).toFixed(2))
            : 0,
        },
        spotlights,
      };
    });

    const venueStrTrim = venue ? String(venue).trim() : '';
    if (venueStrTrim && includeVenuePlayers) {
      const rowsForV = venuePlayerAggRows.filter((r) => r._id?.venue === venueStrTrim);
      const rawRows = rowsForV.map((r) => ({
        playerId: r._id.playerId,
        runs: r.runs || 0,
        balls: r.balls || 0,
        wickets: r.wickets || 0,
        runsGiven: r.runsGiven || 0,
        ballsBowled: r.ballsBowled || 0,
        mom: r.mom || 0,
        appearances: r.appearances || 0,
      }));
      const fakePlayers = ledgerRowsToWcStylePlayers(rawRows, nameByIdLedger, picByIdLedger);
      fakePlayers.sort(
        (a, b) =>
          (b.totals.runs || 0) - (a.totals.runs || 0) ||
          (b.totals.wickets || 0) - (a.totals.wickets || 0)
      );
      const v0 = venues.find((x) => x.venue === venueStrTrim);
      if (v0) {
        v0.players = fakePlayers.slice(0, 120).map((p) => ({
          playerId: p.playerId,
          name: p.name,
          profilePicture: p.profilePicture,
          runs: p.totals.runs,
          balls: p.totals.balls,
          wickets: p.totals.wickets,
          mom: p.totals.mom,
          appearances: p.totals.matches,
        }));
      }
    }

    // Per-player breakdown at each venue (squad view) — only when scoped to an owner user.
    const skipPlayers =
      req.query.includePlayers === '0' || req.query.includePlayers === 'false';
    if (
      userId &&
      mongoose.Types.ObjectId.isValid(String(userId)) &&
      !skipPlayers
    ) {
      const perPlayer = await VenueMatchEntry.aggregate([
        { $match: match },
        {
          $group: {
            _id: { venue: '$venue', playerId: '$playerId' },
            runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            balls: { $sum: { $ifNull: ['$battingStats.balls', 0] } },
            wickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
            ballsBowled: { $sum: { $ifNull: ['$bowlingStats.ballsBowled', 0] } },
          },
        },
      ]);

      const pidSet = new Set();
      for (const row of perPlayer) {
        const pid = row._id?.playerId;
        if (pid && mongoose.Types.ObjectId.isValid(String(pid))) {
          pidSet.add(String(pid));
        }
      }
      const pidList = [...pidSet].map((id) => new mongoose.Types.ObjectId(id));
      const playerDocs =
        pidList.length > 0
          ? await Player.find({ _id: { $in: pidList } })
              .select('name')
              .lean()
          : [];
      const nameById = new Map(
        playerDocs.map((p) => [String(p._id), p.name || 'Player'])
      );

      const byVenue = new Map();
      for (const row of perPlayer) {
        const vName = row._id?.venue;
        const rowPlayerId = row._id?.playerId;
        if (!vName) continue;
        const r = row.runs || 0;
        const b = row.balls || 0;
        const w = row.wickets || 0;
        const bb = row.ballsBowled || 0;
        if (r === 0 && b === 0 && w === 0 && bb === 0) continue;
        if (!byVenue.has(vName)) byVenue.set(vName, []);
        byVenue.get(vName).push({
          playerId: rowPlayerId,
          name: nameById.get(String(rowPlayerId)) || 'Player',
          runs: r,
          balls: b,
          wickets: w,
          ballsBowled: bb,
        });
      }
      for (const arr of byVenue.values()) {
        arr.sort(
          (a, b) =>
            b.runs - a.runs || b.wickets - a.wickets || b.balls - a.balls || b.ballsBowled - a.ballsBowled
        );
      }

      for (const v of venues) {
        v.players = byVenue.get(v.venue) || [];
      }
    }

    const payload = { venues };
    if (!bustCache) venueAnalyticsCache.set(venueAggCacheKey, payload);
    return res.status(200).json(payload);
  } catch (err) {
    console.error('venue-aggregate error:', err);
    return res.status(500).json({ message: 'Failed to compute venue aggregates' });
  }
});

// GET /api/player-stats/venue-explorer
// Optional: ?venue=EXACT_NAME for drill-down, ?scope=league|all (default all), ?tournamentId=...
// Mobile "grounds atlas" — all venues, then team splits + record spots from VenueMatchEntry only.
// Detail payload includes: matchScores (per-game team batting totals), lowestTeamInnings (when < highest).
router.get('/venue-explorer', async (req, res) => {
  try {
    const bustCache =
      req.query.nocache === '1' ||
      req.query.nocache === 'true' ||
      req.query.nocache === 'yes';
    const explorerCacheKey = `vex:${stableVenueCacheKeyFromQuery(req)}`;
    if (!bustCache) {
      const cachedEx = venueAnalyticsCache.get(explorerCacheKey);
      if (cachedEx) return res.status(200).json(cachedEx);
    }

    const { venue: venueQ, scope, tournamentId: rawTournamentId } = req.query;

    const match = { venue: { $nin: [null, ''] } };
    if (rawTournamentId && mongoose.Types.ObjectId.isValid(String(rawTournamentId))) {
      match.tournamentId = new mongoose.Types.ObjectId(rawTournamentId);
    }
    const wantLeagueOnly = scope === 'league';
    if (wantLeagueOnly) {
      match.$and = [
        { isWcScore: { $ne: true } },
        { isPlayoffScore: { $ne: true } },
        { $or: [{ tournamentId: null }, { tournamentId: { $exists: false } }] },
      ];
    }

    const venueStr = venueQ != null ? String(venueQ).trim() : '';

    if (!venueStr) {
      const grouped = await VenueMatchEntry.aggregate([
        { $match: match },
        {
          $addFields: {
            _mid: { $ifNull: ['$matchId', { $toString: '$_id' }] },
          },
        },
        {
          $group: {
            _id: '$venue',
            totalRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            totalWickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
            matchSet: { $addToSet: '$_mid' },
            ledgerRows: { $sum: 1 },
          },
        },
        {
          $addFields: {
            matches: { $size: '$matchSet' },
            teamInnings: { $multiply: [{ $size: '$matchSet' }, 2] },
          },
        },
        { $project: { matchSet: 0 } },
        { $sort: { totalRuns: -1, _id: 1 } },
      ]);
      const venues = grouped.map((r) => ({
        venue: r._id,
        totalRuns: r.totalRuns,
        totalWickets: r.totalWickets,
        matches: r.matches,
        teamInnings: r.teamInnings,
        ledgerRows: r.ledgerRows,
      }));
      const listPayload = { venues };
      if (!bustCache) venueAnalyticsCache.set(explorerCacheKey, listPayload);
      return res.status(200).json(listPayload);
    }

    const detailMatch = { ...match, venue: venueStr };

    const midField = {
      $addFields: { _mid: { $ifNull: ['$matchId', { $toString: '$_id' }] } },
    };

    const loTeamInnLookupStages = [
      { $lookup: { from: 'users', localField: '_id.userId', foreignField: '_id', as: 'u' } },
      {
        $project: {
          runs: '$teamRuns',
          userId: '$_id.userId',
          matchId: '$_id.mid',
          teamName: {
            $ifNull: [
              { $arrayElemAt: ['$u.teamName', 0] },
              { $arrayElemAt: ['$u.name', 0] },
            ],
          },
        },
      },
    ];

    const [
      totAgg,
      teamsAgg,
      topBatAgg,
      topBowlAgg,
      hiTeamInnAgg,
      loTeamInnAgg,
      hiTeamBowlAgg,
      allRoundAgg,
      matchSidesAgg,
    ] = await Promise.all([
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        midField,
        {
          $group: {
            _id: null,
            totalRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            totalWickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
            matchSet: { $addToSet: '$_mid' },
            ledgerRows: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            totalRuns: 1,
            totalWickets: 1,
            ledgerRows: 1,
            matches: { $size: '$matchSet' },
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        {
          $group: {
            _id: '$userId',
            runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            wickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
          },
        },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        {
          $project: {
            userId: '$_id',
            teamName: {
              $ifNull: [
                { $arrayElemAt: ['$u.teamName', 0] },
                { $arrayElemAt: ['$u.name', 0] },
              ],
            },
            runs: 1,
            wickets: 1,
          },
        },
        { $sort: { runs: -1 } },
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        { $sort: { 'battingStats.runs': -1 } },
        { $limit: 1 },
        { $lookup: { from: 'players', localField: 'playerId', foreignField: '_id', as: 'pl' } },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'tm' } },
        {
          $project: {
            runs: { $ifNull: ['$battingStats.runs', 0] },
            balls: { $ifNull: ['$battingStats.balls', 0] },
            playerId: '$playerId',
            playerName: { $arrayElemAt: ['$pl.name', 0] },
            teamName: {
              $ifNull: [
                { $arrayElemAt: ['$tm.teamName', 0] },
                { $arrayElemAt: ['$tm.name', 0] },
              ],
            },
            matchId: 1,
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        { $sort: { 'bowlingStats.wickets': -1, 'bowlingStats.runsGiven': 1 } },
        { $limit: 1 },
        { $lookup: { from: 'players', localField: 'playerId', foreignField: '_id', as: 'pl' } },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'tm' } },
        {
          $project: {
            wickets: { $ifNull: ['$bowlingStats.wickets', 0] },
            runsGiven: { $ifNull: ['$bowlingStats.runsGiven', 0] },
            ballsBowled: { $ifNull: ['$bowlingStats.ballsBowled', 0] },
            playerId: '$playerId',
            playerName: { $arrayElemAt: ['$pl.name', 0] },
            teamName: {
              $ifNull: [
                { $arrayElemAt: ['$tm.teamName', 0] },
                { $arrayElemAt: ['$tm.name', 0] },
              ],
            },
            matchId: 1,
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        midField,
        {
          $group: {
            _id: { mid: '$_mid', userId: '$userId' },
            teamRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
          },
        },
        { $sort: { teamRuns: -1 } },
        { $limit: 1 },
        ...loTeamInnLookupStages,
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        midField,
        {
          $group: {
            _id: { mid: '$_mid', userId: '$userId' },
            teamRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
          },
        },
        { $match: { teamRuns: { $gt: 0 } } },
        { $sort: { teamRuns: 1 } },
        { $limit: 1 },
        ...loTeamInnLookupStages,
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        midField,
        {
          $group: {
            _id: { mid: '$_mid', userId: '$userId' },
            teamWickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
          },
        },
        { $sort: { teamWickets: -1 } },
        { $limit: 1 },
        { $lookup: { from: 'users', localField: '_id.userId', foreignField: '_id', as: 'u' } },
        {
          $project: {
            wickets: '$teamWickets',
            userId: '$_id.userId',
            matchId: '$_id.mid',
            teamName: {
              $ifNull: [
                { $arrayElemAt: ['$u.teamName', 0] },
                { $arrayElemAt: ['$u.name', 0] },
              ],
            },
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        {
          $group: {
            _id: '$playerId',
            runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            wickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
          },
        },
        { $match: { runs: { $gte: 1 }, wickets: { $gte: 1 } } },
        {
          $addFields: {
            index: { $add: ['$runs', { $multiply: [20, '$wickets'] }] },
          },
        },
        { $sort: { index: -1, runs: -1 } },
        { $limit: 1 },
        { $lookup: { from: 'players', localField: '_id', foreignField: '_id', as: 'pl' } },
        {
          $project: {
            playerId: '$_id',
            playerName: { $arrayElemAt: ['$pl.name', 0] },
            runs: 1,
            wickets: 1,
            index: 1,
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: detailMatch },
        midField,
        {
          $group: {
            _id: { mid: '$_mid', userId: '$userId' },
            runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            inningsOrder: { $max: '$teamInningsOrder' },
          },
        },
        {
          $group: {
            _id: '$_id.mid',
            sides: {
              $push: {
                userId: '$_id.userId',
                runs: '$runs',
                inningsOrder: '$inningsOrder',
              },
            },
          },
        },
      ]),
    ]);

    const t0 = totAgg[0];
    const matches = t0?.matches || 0;
    const totals = t0
      ? {
          runs: t0.totalRuns,
          wickets: t0.totalWickets,
          matches,
          teamInnings: matches * 2,
          ledgerRows: t0.ledgerRows,
        }
      : {
          runs: 0,
          wickets: 0,
          matches: 0,
          teamInnings: 0,
          ledgerRows: 0,
        };

    const first = (arr) => (arr && arr.length ? arr[0] : null);
    const hiBat = first(topBatAgg);
    const hiBowl = first(topBowlAgg);
    const hiTeamInn = first(hiTeamInnAgg);
    const loTeamInn = first(loTeamInnAgg);
    const hiTeamBowl = first(hiTeamBowlAgg);
    const bestAr = first(allRoundAgg);

    let lowestTeamInnings = null;
    if (
      loTeamInn &&
      hiTeamInn &&
      loTeamInn.runs > 0 &&
      loTeamInn.runs < hiTeamInn.runs
    ) {
      lowestTeamInnings = loTeamInn;
    }

    const uidSet = new Set();
    for (const doc of matchSidesAgg || []) {
      for (const s of doc.sides || []) {
        if (s.userId) uidSet.add(String(s.userId));
      }
    }
    const uidList = [...uidSet].filter((id) => mongoose.Types.ObjectId.isValid(id));
    const userDocs =
      uidList.length > 0
        ? await User.find({ _id: { $in: uidList.map((id) => new mongoose.Types.ObjectId(id)) } })
            .select('teamName name')
            .lean()
        : [];
    const userMap = new Map(
      userDocs.map((u) => [
        String(u._id),
        (u.teamName && String(u.teamName).trim()) || u.name || 'Team',
      ])
    );

    const matchScores = (matchSidesAgg || [])
      .map((doc) => {
        const sides = (doc.sides || [])
          .map((s) => ({
            userId: s.userId,
            teamName: userMap.get(String(s.userId)) || 'Team',
            runs: s.runs || 0,
            inningsOrder:
              s.inningsOrder === 1 || s.inningsOrder === 2 ? s.inningsOrder : null,
          }))
          .sort((a, b) => {
            const oa = a.inningsOrder != null ? a.inningsOrder : 99;
            const ob = b.inningsOrder != null ? b.inningsOrder : 99;
            if (oa !== ob) return oa - ob;
            return (b.runs || 0) - (a.runs || 0);
          });
        const matchTotal = sides.reduce((sum, s) => sum + (s.runs || 0), 0);
        return {
          matchId: doc._id,
          sides,
          matchTotal,
        };
      })
      .sort((a, b) => String(a.matchId).localeCompare(String(b.matchId)));

    /** Per-team wins when batting 1st vs 2nd (matches with both innings orders recorded). */
    let inningsOrderDecisionMatches = 0;
    const teamOrderStats = new Map();
    const ensureTeamOrder = (uid) => {
      const k = String(uid);
      if (!teamOrderStats.has(k)) {
        teamOrderStats.set(k, {
          matchesBattingFirst: 0,
          matchesBattingSecond: 0,
          winsBattingFirst: 0,
          winsBattingSecond: 0,
        });
      }
      return teamOrderStats.get(k);
    };

    for (const m of matchScores) {
      const sides = m.sides || [];
      if (sides.length !== 2) continue;
      const o0 = sides[0].inningsOrder;
      const o1 = sides[1].inningsOrder;
      if (o0 === null || o1 === null || o0 === o1) continue;
      if ((o0 !== 1 && o0 !== 2) || (o1 !== 1 && o1 !== 2)) continue;

      inningsOrderDecisionMatches += 1;

      const a = sides[0];
      const b = sides[1];
      const ra = Number(a.runs) || 0;
      const rb = Number(b.runs) || 0;

      const stA = ensureTeamOrder(a.userId);
      const stB = ensureTeamOrder(b.userId);
      if (a.inningsOrder === 1) stA.matchesBattingFirst += 1;
      else stA.matchesBattingSecond += 1;
      if (b.inningsOrder === 1) stB.matchesBattingFirst += 1;
      else stB.matchesBattingSecond += 1;

      if (ra > rb) {
        if (a.inningsOrder === 1) stA.winsBattingFirst += 1;
        else stA.winsBattingSecond += 1;
      } else if (rb > ra) {
        if (b.inningsOrder === 1) stB.winsBattingFirst += 1;
        else stB.winsBattingSecond += 1;
      }
    }

    const teamBattingOrderRecord = uidList
      .map((id) => {
        const st = teamOrderStats.get(String(id)) || {
          matchesBattingFirst: 0,
          matchesBattingSecond: 0,
          winsBattingFirst: 0,
          winsBattingSecond: 0,
        };
        return {
          userId: id,
          teamName: userMap.get(String(id)) || 'Team',
          matchesBattingFirst: st.matchesBattingFirst,
          matchesBattingSecond: st.matchesBattingSecond,
          winsBattingFirst: st.winsBattingFirst,
          winsBattingSecond: st.winsBattingSecond,
        };
      })
      .sort((x, y) => String(x.teamName).localeCompare(String(y.teamName)));

    const detailPayload = {
      venue: venueStr,
      totals,
      teams: teamsAgg,
      matchScores,
      highestScore: hiBat && hiBat.runs > 0 ? hiBat : null,
      bestBowling: hiBowl && hiBowl.wickets > 0 ? hiBowl : null,
      highestTeamInnings: hiTeamInn && hiTeamInn.runs > 0 ? hiTeamInn : null,
      lowestTeamInnings,
      bestTeamBowlingInnings: hiTeamBowl && hiTeamBowl.wickets > 0 ? hiTeamBowl : null,
      bestAllrounder: bestAr || null,
      inningsOrderDecisionMatches,
      teamBattingOrderRecord,
    };
    if (!bustCache) venueAnalyticsCache.set(explorerCacheKey, detailPayload);
    return res.status(200).json(detailPayload);
  } catch (err) {
    console.error('venue-explorer error:', err);
    return res.status(500).json({ message: 'Failed to load venue explorer' });
  }
});

// GET /api/player-stats/venue-insight?venue=NAME&scope=all|league
// Tactical hints from ledger: spin vs pace lean, toss lean (heuristic), main assets.
// Optional: set OPENAI_API_KEY for an extra LLM narrative (gpt-4o-mini by default).
router.get('/venue-insight', async (req, res) => {
  try {
    const bustCache =
      req.query.nocache === '1' ||
      req.query.nocache === 'true' ||
      req.query.nocache === 'yes';
    const insightKey = `vins:${stableVenueCacheKeyFromQuery(req)}`;
    if (!bustCache) {
      const hit = venueAnalyticsCache.get(insightKey);
      if (hit) return res.status(200).json(hit);
    }

    const { venue: venueQ, scope, tournamentId: rawTournamentId } = req.query;
    const venueStr = venueQ != null ? String(venueQ).trim() : '';
    if (!venueStr) {
      return res.status(400).json({ message: 'venue query parameter is required' });
    }

    const match = { venue: venueStr };
    if (rawTournamentId && mongoose.Types.ObjectId.isValid(String(rawTournamentId))) {
      match.tournamentId = new mongoose.Types.ObjectId(rawTournamentId);
    }
    const wantLeagueOnly = scope === 'league';
    if (wantLeagueOnly) {
      match.$and = [
        { isWcScore: { $ne: true } },
        { isPlayoffScore: { $ne: true } },
        { $or: [{ tournamentId: null }, { tournamentId: { $exists: false } }] },
      ];
    }

    const midField = {
      $addFields: { _mid: { $ifNull: ['$matchId', { $toString: '$_id' }] } },
    };

    const [
      totAgg,
      topBatAgg,
      topBowlAgg,
      allRoundAgg,
      chaseDocs,
      inningsOrderDocs,
    ] = await Promise.all([
      VenueMatchEntry.aggregate([
        { $match: match },
        midField,
        {
          $group: {
            _id: null,
            totalRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            totalWickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
            matchSet: { $addToSet: '$_mid' },
          },
        },
        {
          $project: {
            _id: 0,
            totalRuns: 1,
            totalWickets: 1,
            matches: { $size: '$matchSet' },
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$playerId',
            runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
          },
        },
        { $match: { runs: { $gte: 1 } } },
        { $sort: { runs: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'players', localField: '_id', foreignField: '_id', as: 'pl' } },
        {
          $project: {
            playerId: '$_id',
            name: { $ifNull: [{ $arrayElemAt: ['$pl.name', 0] }, 'Player'] },
            role: { $arrayElemAt: ['$pl.role', 0] },
            runs: 1,
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$playerId',
            wickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
            runsGiven: { $sum: { $ifNull: ['$bowlingStats.runsGiven', 0] } },
            ballsBowled: { $sum: { $ifNull: ['$bowlingStats.ballsBowled', 0] } },
          },
        },
        { $match: { wickets: { $gte: 1 } } },
        { $sort: { wickets: -1, runsGiven: 1 } },
        { $limit: 12 },
        { $lookup: { from: 'players', localField: '_id', foreignField: '_id', as: 'pl' } },
        {
          $project: {
            playerId: '$_id',
            name: { $ifNull: [{ $arrayElemAt: ['$pl.name', 0] }, 'Bowler'] },
            role: { $arrayElemAt: ['$pl.role', 0] },
            style: { $arrayElemAt: ['$pl.style', 0] },
            wickets: 1,
            runsGiven: 1,
            ballsBowled: 1,
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$playerId',
            runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            wickets: { $sum: { $ifNull: ['$bowlingStats.wickets', 0] } },
          },
        },
        { $match: { runs: { $gte: 1 }, wickets: { $gte: 1 } } },
        {
          $addFields: {
            index: { $add: ['$runs', { $multiply: [20, '$wickets'] }] },
          },
        },
        { $sort: { index: -1, runs: -1 } },
        { $limit: 3 },
        { $lookup: { from: 'players', localField: '_id', foreignField: '_id', as: 'pl' } },
        {
          $project: {
            playerId: '$_id',
            playerName: { $arrayElemAt: ['$pl.name', 0] },
            role: { $arrayElemAt: ['$pl.role', 0] },
            style: { $arrayElemAt: ['$pl.style', 0] },
            runs: 1,
            wickets: 1,
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: match },
        midField,
        {
          $group: {
            _id: { mid: '$_mid', userId: '$userId' },
            teamRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
          },
        },
        {
          $group: {
            _id: '$_id.mid',
            runsList: { $push: '$teamRuns' },
          },
        },
        {
          $match: {
            $expr: { $gte: [{ $size: '$runsList' }, 2] },
          },
        },
      ]),
      VenueMatchEntry.aggregate([
        { $match: match },
        midField,
        {
          $group: {
            _id: { mid: '$_mid', userId: '$userId' },
            teamRuns: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
            inningsOrder: { $max: '$teamInningsOrder' },
          },
        },
        {
          $group: {
            _id: '$_id.mid',
            sides: {
              $push: {
                userId: '$_id.userId',
                teamRuns: '$teamRuns',
                inningsOrder: '$inningsOrder',
              },
            },
          },
        },
        {
          $match: {
            $expr: { $gte: [{ $size: '$sides' }, 2] },
          },
        },
      ]),
    ]);

    const t0 = totAgg[0];
    const matches = t0?.matches || 0;
    const totalRuns = t0?.totalRuns || 0;
    const totalWickets = t0?.totalWickets || 0;
    const teamInnings = Math.max(1, matches * 2);
    const avgTeamInnings = totalRuns / teamInnings;
    const wktsPerTeamInnings = totalWickets / teamInnings;

    let closeChaseRate = 0;
    let twoTeamMatches = 0;
    for (const doc of chaseDocs || []) {
      const arr = (doc.runsList || []).map((n) => Number(n) || 0).filter((n) => n > 0);
      if (arr.length < 2) continue;
      const mx = Math.max(...arr);
      const mn = Math.min(...arr);
      if (mx <= 0) continue;
      twoTeamMatches += 1;
      if (mn >= 0.85 * mx) closeChaseRate += 1;
    }
    const closeRate = twoTeamMatches ? closeChaseRate / twoTeamMatches : 0;

    let inningsOrderMatches = 0;
    let sumRunsFirst = 0;
    let sumRunsSecond = 0;
    let batFirstWins = 0;
    for (const doc of inningsOrderDocs || []) {
      const sides = doc.sides || [];
      if (sides.length !== 2) continue;
      const a = sides[0];
      const b = sides[1];
      const oa = a.inningsOrder;
      const ob = b.inningsOrder;
      if ((oa !== 1 && oa !== 2) || (ob !== 1 && ob !== 2) || oa === ob) continue;
      const firstSide = oa === 1 ? a : b;
      const secondSide = oa === 2 ? a : b;
      const rFirst = Number(firstSide.teamRuns) || 0;
      const rSecond = Number(secondSide.teamRuns) || 0;
      inningsOrderMatches += 1;
      sumRunsFirst += rFirst;
      sumRunsSecond += rSecond;
      if (rFirst > rSecond) batFirstWins += 1;
    }

    const inningsOrderStats =
      inningsOrderMatches >= 2
        ? {
            matches: inningsOrderMatches,
            avgRunsBattingFirst: sumRunsFirst / inningsOrderMatches,
            avgRunsBattingSecond: sumRunsSecond / inningsOrderMatches,
            batFirstWinRate: batFirstWins / inningsOrderMatches,
          }
        : null;

    const toss = venueInsights.tossLeanFromNumbers({
      avgTeamInnings,
      wktsPerTeamInnings,
      closeChaseRate: closeRate,
      matches,
      inningsOrderStats,
    });

    const bowlersForStyle = (topBowlAgg || []).map((b) => ({
      playerId: b.playerId,
      name: b.name,
      wickets: b.wickets,
      style: b.style,
      role: b.role,
    }));
    const spinPace = venueInsights.spinPaceFromBowlers(bowlersForStyle);

    const assets = {
      batters: (topBatAgg || []).map((b) => ({
        playerId: b.playerId,
        name: b.name,
        role: b.role,
        runs: b.runs,
      })),
      bowlers: bowlersForStyle.slice(0, 5),
      allrounders: (allRoundAgg || []).map((a) => ({
        playerId: a.playerId,
        name: a.playerName || 'Player',
        role: a.role,
        style: a.style,
        runs: a.runs,
        wickets: a.wickets,
      })),
    };

    const disclaimer =
      inningsOrderStats && inningsOrderStats.matches >= 2
        ? 'Based on your league’s saved scorecards at this venue. Toss hints use first- vs second-innings team totals where batting order is recorded (OCR “who batted first” or scripts/promptVenueMatchInningsOrder.js).'
        : 'Based on your league’s saved scorecards at this venue — not weather or real pitch reports. For sharper toss hints, record who batted first when saving scorecards or run scripts/promptVenueMatchInningsOrder.js once for older games.';

    const bowlersAtVenueForAi = venueInsights.annotateBowlersForSnapshot(
      bowlersForStyle.slice(0, 10)
    );
    const allroundersForAi = (assets.allrounders || []).slice(0, 4).map((a) => ({
      name: a.name,
      role: a.role || null,
      styleFromRoster: a.style || null,
      runsAtVenue: a.runs,
      wicketsAtVenue: a.wickets,
      bowlingType: venueInsights.classifyBowlingStyle(a.style),
    }));

    const snapshot = {
      venue: venueStr,
      dataProvenance:
        'Bowling type (spin vs pace) is from Player.style in your DB at request time, rule-classified as bowlingType. OpenAI must not override this with guesses from names.',
      matches,
      avgTeamInnings: Number(avgTeamInnings.toFixed(1)),
      wktsPerTeamInnings: Number(wktsPerTeamInnings.toFixed(2)),
      closeGameRate: twoTeamMatches ? Number(closeRate.toFixed(2)) : null,
      toss: toss.key,
      inningsOrder: toss.inningsOrder || null,
      spinPaceHeuristic: {
        recommendation: spinPace.recommendation,
        label: spinPace.label,
        spinWicketShare: spinPace.spinWicketShare,
        paceWicketShare: spinPace.paceWicketShare,
      },
      bowlersAtVenue: bowlersAtVenueForAi,
      allroundersAtVenue: allroundersForAi,
      topBatters: assets.batters.slice(0, 3),
      topBowlers: assets.bowlers.slice(0, 3),
      allrounders: assets.allrounders.slice(0, 2),
    };

    let aiNarrative = null;
    let aiError = null;
    let aiErrorKind = null;
    let aiProvider = null;
    const venueAiEnabled = (() => {
      const v = process.env.VENUE_AI_ENABLED;
      if (v !== undefined && String(v).trim() !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
      }
      return !['0', 'false', 'no', 'off'].includes(
        String(process.env.OPENAI_VENUE_ENABLED || '1').toLowerCase()
      );
    })();
    const hideQuotaBanner = ['1', 'true', 'yes', 'on'].includes(
      String(
        process.env.VENUE_AI_HIDE_QUOTA_ERRORS ||
          process.env.OPENAI_VENUE_HIDE_QUOTA_ERRORS ||
          ''
      ).toLowerCase()
    );
    if (venueAiEnabled && venueInsights.resolveVenueAiProvider()) {
      const aiResult = await venueInsights.enrichVenueInsightWithLLM({ axios, snapshot });
      if (aiResult?.text) {
        aiNarrative = aiResult.text;
        aiProvider = aiResult.provider || null;
      } else if (aiResult?.error) {
        aiProvider = aiResult.provider || null;
        const kind = aiResult.kind || null;
        if (hideQuotaBanner && kind === 'quota') {
          /* optional: no banner when quota exhausted */
        } else {
          aiError = aiResult.error;
          aiErrorKind = kind;
        }
      }
    }

    const heuristicNarrative = venueInsights.buildHeuristicNarrative({
      venueStr,
      totals: { runs: totalRuns, wickets: totalWickets, matches, teamInnings },
      toss,
      spinPace,
      assets: {
        batters: assets.batters.slice(0, 3),
        bowlers: assets.bowlers.slice(0, 3),
      },
      closeChaseRate: twoTeamMatches ? closeRate : null,
      matches,
    });

    const payload = {
      venue: venueStr,
      disclaimer,
      metrics: {
        matches,
        totalRuns,
        totalWickets,
        avgTeamInnings: Number(avgTeamInnings.toFixed(1)),
        wktsPerTeamInnings: Number(wktsPerTeamInnings.toFixed(2)),
        twoTeamMatchesSampled: twoTeamMatches,
        closeGameRate: twoTeamMatches ? Number(closeRate.toFixed(2)) : null,
        inningsOrderMatchesUsed: inningsOrderMatches,
      },
      toss,
      spinVsPace: spinPace,
      mainAssets: assets,
      narratives: {
        heuristicMarkdown: heuristicNarrative,
        aiMarkdown: aiNarrative,
        aiError: aiError || undefined,
        aiErrorKind: aiErrorKind || undefined,
        aiProvider: aiProvider || undefined,
      },
      snapshot,
    };

    if (!bustCache) venueAnalyticsCache.set(insightKey, payload);
    return res.status(200).json(payload);
  } catch (err) {
    console.error('venue-insight error:', err);
    return res.status(500).json({ message: 'Failed to build venue insight' });
  }
});

const WC_MATCH_BUCKET_MS = 120000;

/** Stable key so all PlayerStat rows from the same WC scorecard share one match outcome. */
function buildWcMatchKey(stat) {
  const uid = stat.userId?._id ? String(stat.userId._id) : String(stat.userId || '');
  const oid = stat.opponentUserId?._id
    ? String(stat.opponentUserId._id)
    : String(stat.opponentUserId || '');
  if (!uid || !oid || uid === 'undefined' || oid === 'undefined') return null;
  const pair = uid < oid ? `${uid}:${oid}` : `${oid}:${uid}`;
  const stage = stat.metadata?.wcStage || '';
  const venue = (stat.venue || '').trim();
  const slot = Math.floor(new Date(stat.createdAt).getTime() / WC_MATCH_BUCKET_MS);
  return `${pair}|${stage}|${venue}|${slot}`;
}

// GET /api/player-stats/wc-stats?tournamentId=...
// Returns all PlayerStats entries flagged as WC scores for teams subscribed to a given tournament.
// Used by the World Cup tournament detail view to show per-match player contributions.
// Also returns `teams`: aggregates (runs, wickets, W–L from matchWinnerSide) and per-team spotlights.
router.get('/wc-stats', async (req, res) => {
  try {
    const { tournamentId } = req.query;
    if (!tournamentId) {
      return res.status(400).json({ message: 'tournamentId is required' });
    }

    const tournament = await Tournament.findById(tournamentId).lean();
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const subscribedUserIds = (tournament.subscribedTeams || [])
      .map((t) => t.userId)
      .filter(Boolean);

    // Primary scope: anything tagged with this tournamentId.
    // Fallback (for entries saved before tournamentId was tracked): match by subscribed userIds + start date.
    const startBound = tournament.startDate ? new Date(tournament.startDate) : null;
    const orConditions = [{ tournamentId: tournament._id }];
    if (subscribedUserIds.length) {
      orConditions.push({
        tournamentId: null,
        $or: [
          { userId: { $in: subscribedUserIds } },
          { opponentUserId: { $in: subscribedUserIds } },
        ],
      });
    }
    const query = {
      'metadata.isWcScore': true,
      $or: orConditions,
    };
    if (startBound && !Number.isNaN(startBound.getTime())) {
      query.createdAt = { $gte: startBound };
    }

    const stats = await PlayerStats.find(query)
      .populate('playerId', 'name role type profilePicture')
      .populate('userId', 'teamName')
      .populate('opponentUserId', 'teamName')
      .sort({ createdAt: 1 })
      .lean();

    // Group by player so the UI can render per-player match contributions
    const byPlayer = new Map();
    stats.forEach((stat) => {
      const player = stat.playerId;
      if (!player || !player._id) return;
      const key = String(player._id);
      if (!byPlayer.has(key)) {
        byPlayer.set(key, {
          playerId: key,
          name: player.name || 'Unknown Player',
          role: player.role || null,
          type: player.type || null,
          profilePicture: player.profilePicture || null,
          team: stat.userId?.teamName || null,
          totals: { runs: 0, balls: 0, wickets: 0, runsGiven: 0, ballsBowled: 0, mom: 0, matches: 0 },
          matches: [],
        });
      }
      const entry = byPlayer.get(key);
      const runs = stat.battingStats?.runs || 0;
      const balls = stat.battingStats?.balls || 0;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;
      entry.totals.runs += runs;
      entry.totals.balls += balls;
      entry.totals.wickets += wickets;
      entry.totals.runsGiven += runsGiven;
      entry.totals.ballsBowled += ballsBowled;
      entry.totals.mom += stat.isMom ? 1 : 0;
      entry.totals.matches += 1;
      entry.matches.push({
        statId: stat._id,
        opponent: stat.opponentUserId?.teamName || 'Unknown',
        runs,
        balls,
        wickets,
        runsGiven,
        ballsBowled,
        isMom: !!stat.isMom,
        wcStage: stat.metadata?.wcStage || null,
        venue: stat.venue || null,
        createdAt: stat.createdAt,
      });
    });

    // Order each player's matches: super8 → semi → final, then by date.
    const stageOrder = { super8: 0, semi: 1, final: 2 };
    byPlayer.forEach((entry) => {
      entry.matches.sort((a, b) => {
        const sa = stageOrder[a.wcStage] ?? 99;
        const sb = stageOrder[b.wcStage] ?? 99;
        if (sa !== sb) return sa - sb;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
    });

    const players = Array.from(byPlayer.values()).sort((a, b) => {
      const runsDiff = (b.totals.runs || 0) - (a.totals.runs || 0);
      if (runsDiff !== 0) return runsDiff;
      return (b.totals.wickets || 0) - (a.totals.wickets || 0);
    });

    const matchBuckets = new Map();
    for (const stat of stats) {
      const mk = buildWcMatchKey(stat);
      if (!mk) continue;
      if (!matchBuckets.has(mk)) {
        matchBuckets.set(mk, {
          userTeam: stat.userId?.teamName || null,
          oppTeam: stat.opponentUserId?.teamName || null,
          winnerSide: stat.metadata?.matchWinnerSide || null,
        });
      } else {
        const b = matchBuckets.get(mk);
        if (!b.winnerSide && stat.metadata?.matchWinnerSide) {
          b.winnerSide = stat.metadata.matchWinnerSide;
        }
        if (!b.userTeam && stat.userId?.teamName) b.userTeam = stat.userId.teamName;
        if (!b.oppTeam && stat.opponentUserId?.teamName) b.oppTeam = stat.opponentUserId.teamName;
      }
    }

    const teamAgg = new Map();
    const ensureTeam = (name) => {
      const t = name || 'Unknown team';
      if (!teamAgg.has(t)) {
        teamAgg.set(t, {
          teamName: t,
          totalRuns: 0,
          totalWickets: 0,
          wins: 0,
          losses: 0,
        });
      }
      return teamAgg.get(t);
    };

    for (const p of players) {
      const row = ensureTeam(p.team);
      row.totalRuns += p.totals.runs || 0;
      row.totalWickets += p.totals.wickets || 0;
    }

    for (const m of matchBuckets.values()) {
      const { userTeam, oppTeam, winnerSide } = m;
      if (!winnerSide || !userTeam || !oppTeam) continue;
      const winner = winnerSide === 'home' ? userTeam : oppTeam;
      const loser = winnerSide === 'home' ? oppTeam : userTeam;
      ensureTeam(winner).wins += 1;
      ensureTeam(loser).losses += 1;
    }

    const teams = Array.from(teamAgg.values())
      .map((row) => {
        const teamPlayers = players.filter((p) => (p.team || 'Unknown team') === row.teamName);
        return {
          ...row,
          playerCount: teamPlayers.length,
          spotlights: computeWcTeamSpotlights(teamPlayers),
        };
      })
      .sort(
        (a, b) =>
          (b.totalRuns || 0) - (a.totalRuns || 0) ||
          (b.wins || 0) - (a.wins || 0) ||
          String(a.teamName).localeCompare(String(b.teamName))
      );

    const overallSpotlights = computeWcTeamSpotlights(players);

    return res.json({
      tournamentId,
      tournamentName: tournament.name,
      players,
      teams,
      overallSpotlights,
    });
  } catch (error) {
    console.error('Error fetching WC stats:', error);
    return res.status(500).json({ message: 'Error fetching WC stats' });
  }
});

// POST /api/player-stats/clear-all-cache - Clear ALL backend caches (stats, fixtures, players, users, news). Use after direct DB edits.
// Body: { adminUserId: "..." } or ?adminUserId=...
router.post('/clear-all-cache', async (req, res) => {
  try {
    const adminUserId = req.body?.adminUserId || req.query?.adminUserId;
    if (!adminUserId) return res.status(400).json({ message: 'adminUserId is required' });
    const admin = await User.findById(adminUserId).select('isAdmin').lean();
    if (!admin?.isAdmin) return res.status(403).json({ message: 'Only admin can clear all caches' });
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
router.post('/clear-cache', async (req, res) => {
  try {
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data');
    venueAnalyticsCache.flushAll();

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
        {
          $set: {
            totalRuns: 0,
            totalWickets: 0,
            matchesPlayed: 0,
            totalNotOutInnings: 0,
            totalRunsGiven: 0,
            totalBalls: 0,
            totalBallsBowled: 0,
            momCount: 0,
          },
        }
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
    venueAnalyticsCache.flushAll();

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
      isWcScore,
      wcStage: bulkWcStage,
      tournamentId: bulkTournamentId,
      venue: bulkVenue,
      matchWinnerSide: bulkMatchWinnerSide,
    } = req.body || {};

    const normalizedBulkVenue = typeof bulkVenue === 'string' ? bulkVenue.trim() : bulkVenue || null;

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
      const statsTeamUserId = await resolveStatsTeamUserId(entry.userId, ownerUser._id);

      const batStats = sanitizeBattingStats(entry.battingStats);
      const bowlStats = sanitizeBowlingStats(entry.bowlingStats, entry.wicketsTaken);
      const resolvedOpponentUserId = await resolveOpponentUserId(
        entry.opponentUserId,
        entry.opponentTeamName
      );

      const normalizedMatchKey = entry.matchKey || matchKey || null;
      const normalizedMatchName = entry.matchName || matchName || null;
      const normalizedMatchId = entry.matchId || req.body.matchId || null;
      const entryIsPlayoffScore =
        entry.isPlayoffScore !== undefined
          ? !!entry.isPlayoffScore
          : isPlayoffScore !== undefined
          ? !!isPlayoffScore
          : false;
      const entryIsWcScore =
        entry.isWcScore !== undefined
          ? !!entry.isWcScore
          : isWcScore !== undefined
          ? !!isWcScore
          : false;
      const entryWcStage = entryIsWcScore
        ? normalizeWcStage(entry.wcStage !== undefined ? entry.wcStage : bulkWcStage)
        : null;
      const entryTournamentId = entry.tournamentId || bulkTournamentId || null;
      const entryVenueRaw = entry.venue !== undefined ? entry.venue : normalizedBulkVenue;
      const entryVenue = typeof entryVenueRaw === 'string' ? entryVenueRaw.trim() : entryVenueRaw || null;
      const entryMatchWinnerSideRaw =
        entry.matchWinnerSide !== undefined ? entry.matchWinnerSide : bulkMatchWinnerSide;

      if (entryIsWcScore && !entryWcStage) {
        warnings.push(`Skipping WC entry for player ${entry.playerId}: wcStage must be super8 | semi | final`);
        continue;
      }

      // Build the lookup query based on score type (same rules as savePlayerStatsEntry).
      let statDoc = null;
      if (entryIsWcScore) {
        statDoc = await PlayerStats.findOne({
          playerId: entry.playerId,
          userId: statsTeamUserId,
          opponentUserId: resolvedOpponentUserId || null,
          tournamentId: entryTournamentId,
          'metadata.isWcScore': true,
          'metadata.wcStage': entryWcStage,
        });
      } else if (!entryIsPlayoffScore) {
        const baseQuery = {
          playerId: entry.playerId,
          userId: statsTeamUserId,
          $and: [
            { $or: [{ 'metadata.isWcScore': { $ne: true } }, { 'metadata.isWcScore': { $exists: false } }] },
            { $or: [{ 'metadata.isPlayoffScore': { $ne: true } }, { 'metadata.isPlayoffScore': { $exists: false } }] },
          ],
        };
        if (normalizedMatchKey) {
          baseQuery.matchKey = normalizedMatchKey;
        } else if (resolvedOpponentUserId) {
          baseQuery.opponentUserId = resolvedOpponentUserId;
        }
        statDoc = await PlayerStats.findOne(baseQuery);
      }

      // Calculate new totals for delta calculation
      const newTotals = {
        runs: batStats?.runs || 0,
        balls: batStats?.balls || 0,
        notOut: batStats?.notOut ? 1 : 0,
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
        notOut: 0,
      };

      // Decision rules (in this priority):
      //   - WC entries: dedup within (player, owner, opponent, tournamentId, wcStage). Overwrite if found.
      //   - Playoff (non-WC): always create new (allow duplicates).
      //   - Regular (non-WC, non-playoff): dedup ignoring WC/playoff buckets.
      if (statDoc) {
        // Calculate delta from previous stats
        const previousTotals = {
          runs: statDoc.battingStats?.runs || 0,
          balls: statDoc.battingStats?.balls || 0,
          notOut: statDoc.battingStats?.notOut ? 1 : 0,
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
        deltaTotals.notOut = newTotals.notOut - previousTotals.notOut;

        // Update existing entry (regular match)
        statDoc.opponentUserId = resolvedOpponentUserId || statDoc.opponentUserId || null;
        statDoc.matchName = normalizedMatchName || statDoc.matchName || null;
        statDoc.matchKey = normalizedMatchKey || statDoc.matchKey || null;
        statDoc.fixtureId = entry.fixtureId || fixtureId || statDoc.fixtureId || null;
        statDoc.isPlayoffScore = entryIsPlayoffScore;
        statDoc.battingStats = {
          runs: batStats?.runs || 0,
          balls: batStats?.balls || 0,
          notOut: !!batStats?.notOut,
        };
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
        statDoc.metadata.isWcScore = entryIsWcScore;
        if (entryIsWcScore) {
          statDoc.metadata.wcStage = entryWcStage;
          statDoc.tournamentId = entryTournamentId;
        }
        if (entryVenue) {
          statDoc.venue = entryVenue;
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'teamInningsOrder')) {
          statDoc.teamInningsOrder =
            entry.teamInningsOrder === 1 || entry.teamInningsOrder === 2
              ? entry.teamInningsOrder
              : null;
        }
        statDoc.metadata.matchWinnerSide = normalizeMatchWinnerSide(entryMatchWinnerSideRaw);

        await statDoc.save();
        
        await syncCareerAndRankingAfterStatChange(entry.playerId, deltaTotals, 'bulk-update');
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
        deltaTotals.notOut = newTotals.notOut;

        statDoc = new PlayerStats({
          playerId: entry.playerId,
          userId: statsTeamUserId,
          opponentUserId: resolvedOpponentUserId || null,
          tournamentId: entryIsWcScore ? entryTournamentId : null,
          venue: entryVenue || null,
          matchName: normalizedMatchName || null,
          matchKey: normalizedMatchKey || null,
          fixtureId: entry.fixtureId || fixtureId || null,
          isPlayoffScore: entryIsPlayoffScore,
          teamInningsOrder:
            entry.teamInningsOrder === 1 || entry.teamInningsOrder === 2
              ? entry.teamInningsOrder
              : null,
          battingStats: {
            runs: batStats?.runs || 0,
            balls: batStats?.balls || 0,
            notOut: !!batStats?.notOut,
          },
          bowlingStats: bowlStats,
          isMom: !!entry.isMom,
          metadata: {
            economy: entry.economy !== null && entry.economy !== undefined ? Number(entry.economy) : null,
            extras: entry.extras !== null && entry.extras !== undefined ? Number(entry.extras) : null,
            isPlayoffScore: entryIsPlayoffScore,
            isWcScore: entryIsWcScore,
            wcStage: entryIsWcScore ? entryWcStage : null,
            matchWinnerSide: normalizeMatchWinnerSide(entryMatchWinnerSideRaw),
          },
        });

        await statDoc.save();
        
        await syncCareerAndRankingAfterStatChange(entry.playerId, deltaTotals, 'bulk-create');
      }

      // Mirror to persistent venue ledger (survives PlayerStats wipes).
      await upsertVenueMatchEntry(statDoc, { matchId: normalizedMatchId });
      await syncPlayerTeamTournamentStatFromPlayerStats(statDoc);

      successCount += 1;
    }

    // 🚀 PERFORMANCE: Invalidate stats-overview, player-stats-list, and players data cache when stats are saved
    cache.del('stats-overview');
    invalidateCache('player-stats-list');
    invalidateCache('players:data'); // Invalidate top rankings cache
    venueAnalyticsCache.flushAll();

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
      .populate('opponentUserId', 'name teamName'); // Populate opponent details

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
        opponent: stat.opponentUserId?.teamName || stat.opponentUserId?.name || null,
        opponentUserId: stat.opponentUserId?._id || stat.opponentUserId || null,
        battingStats: stat.battingStats,
        bowlingStats: stat.bowlingStats,
        isMom: stat.isMom,
        tournamentId: stat.tournamentId || null,
        metadata: {
          isPlayoffScore: !!stat.metadata?.isPlayoffScore,
          isWcScore: !!stat.metadata?.isWcScore,
          wcStage: stat.metadata?.wcStage || null,
        },
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

    const overviewPlayerIds = [
      ...new Set(filteredStats.map((s) => s.playerId?._id).filter(Boolean)),
    ];
    const currentOwnerTeamByPlayerId = await buildCurrentOwnerTeamByPlayerId(overviewPlayerIds);
    const displayTeamName = (statDoc) =>
      resolveTeamNameFromOwnerMap(
        currentOwnerTeamByPlayerId,
        statDoc.playerId?._id,
        statDoc.userId?.teamName
      );

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
    const notOutCountMap = {};
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
      const teamName = displayTeamName(statDoc);
      const opponentName = opponentUserId?.teamName ?? 'Unknown Opponent';

      // A) Single-match computations
      const runs = battingStats?.runs || 0;
      const balls = battingStats?.balls || 0;
      const isNotOut = !!battingStats?.notOut;
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
      if (!notOutCountMap[pId]) notOutCountMap[pId] = 0;
      if (isNotOut) notOutCountMap[pId] += 1;

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
          teamName: displayTeamName(statDoc),
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
      const notOutInnings = notOutCountMap[pid] || 0;
      const dismissals = countDismissals(matchCount, notOutInnings);
      const avg = matchCount > 0 ? battingAverageFromTotals(runs, matchCount, notOutInnings) : 0;
      return {
        playerId: pid,
        playerName: playerInfoMap[pid]?.playerName || 'Unknown Player',
        playerType: playerInfoMap[pid]?.playerType || null,
        profilePicture: playerInfoMap[pid]?.profilePicture ?? null,
        teamName: playerInfoMap[pid]?.teamName || 'Unknown Team',
        matches: matchCount,
        notOutInnings,
        dismissals,
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

    // Find the user who owns this player (active roster, not stale boughtPlayers)
    const ownerUser = await findCurrentOwnerUser(playerId);
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
    let notOutInnings = 0;
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
      const isNotOut = !!stat.battingStats?.notOut;
      const wickets = stat.bowlingStats?.wickets || 0;
      const runsGiven = stat.bowlingStats?.runsGiven || 0;
      const ballsBowled = stat.bowlingStats?.ballsBowled || 0;

      // Add to totals
      totalRuns += runs;
      totalBalls += balls;
      if (isNotOut) notOutInnings += 1;
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
        notOut: isNotOut,
        wickets: wickets,
        runsGiven: runsGiven,
        ballsBowled: ballsBowled,
        economy: hasValidEconomy ? parseFloat(economy.toFixed(2)) : null,
        isMom: stat.isMom || false
      };
    });

    // Calculate averages
    const dismissals = countDismissals(matchCount, notOutInnings);
    const average = matchCount > 0 ? battingAverageFromTotals(totalRuns, matchCount, notOutInnings) : 0;
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
      notOutInnings,
      dismissals,
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
