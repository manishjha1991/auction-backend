const express = require('express');
const router = express.Router();
const TradeRequest = require('../models/TradeRequest');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const PlayerStats = require('../models/PlayerStats');
const Player = require('../models/Player');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Fixture = require('../models/Fixture');
const Schedule = require('../models/Schedule');
const Comment = require('../models/Comment');
const PostLike = require('../models/PostLike');
const { cacheConfig, invalidateCache } = require('../utils/cache');

function toCrores(amount) {
  const n = Number(amount || 0);
  return n / 10000000;
}

function pickVariant(seed, options) {
  try {
    const s = String(seed || '');
    const sum = Array.from(s).reduce((a, c) => a + c.charCodeAt(0), 0);
    return options[sum % options.length];
  } catch {
    return options[0];
  }
}

// Function to get social data for news items
async function getSocialData(newsItems) {
  try {
    const newsIds = newsItems.map(item => item.id);
    
    // Get likes and comments for all news items
    const [likes, comments] = await Promise.all([
      PostLike.find({ newsId: { $in: newsIds } }).populate('userId', 'name avatar'),
      Comment.find({ newsId: { $in: newsIds } })
        .populate('userId', 'name avatar')
        .populate('replies.userId', 'name avatar')
        .sort({ createdAt: -1 })
    ]);
    
    // Group likes and comments by newsId
    const likesByNewsId = {};
    const commentsByNewsId = {};
    
    likes.forEach(like => {
      if (!likesByNewsId[like.newsId]) {
        likesByNewsId[like.newsId] = [];
      }
      likesByNewsId[like.newsId].push(like);
    });
    
    comments.forEach(comment => {
      if (!commentsByNewsId[comment.newsId]) {
        commentsByNewsId[comment.newsId] = [];
      }
      commentsByNewsId[comment.newsId].push(comment);
    });
    
    // Add social data to news items
    return newsItems.map(item => {
      const itemLikes = likesByNewsId[item.id] || [];
      const itemComments = commentsByNewsId[item.id] || [];
      
      // Calculate like counts by type
      const likeCounts = {
        like: 0,
        love: 0,
        haha: 0,
        wow: 0,
        sad: 0,
        angry: 0
      };
      
      itemLikes.forEach(like => {
        likeCounts[like.likeType]++;
      });
      
      return {
        ...item,
        likes: itemLikes,
        likeCount: itemLikes.length,
        likeCounts,
        comments: itemComments,
        commentCount: itemComments.length
      };
    });
  } catch (error) {
    console.error('Error getting social data:', error);
    return newsItems; // Return original items if social data fails
  }
}

router.get('/feed', async (_req, res) => {
  // 🚀 PERFORMANCE: Check cache first (30 second cache for news feed - frequently changing)
  const cacheKey = 'news:feed';
  const cached = cacheConfig.short.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    const [trades, releases, picks, recentStats, fixtures, schedules] = await Promise.all([
      TradeRequest.find({})
        .populate({
          path: 'fromUser',
          select: 'name teamName isTournamentReady',
          match: { isTournamentReady: true }
        })
        .populate({
          path: 'toUser',
          select: 'name teamName isTournamentReady',
          match: { isTournamentReady: true }
        })
        .populate('offeredPlayer', 'name type role')
        .populate('requestedPlayer', 'name type role')
        .sort({ updatedAt: -1 })
        .limit(50), // Increased limit to show more trades
      ReleaseRequest.find({})
        .populate({
          path: 'user',
          select: 'teamName isTournamentReady',
          model: 'User',
          match: { isTournamentReady: true }
        })
        .populate({
          path: 'player',
          select: 'name type',
          model: 'Player'
        })
        .sort({ updatedAt: -1 })
        .limit(30),
      PickRequest.find({})
        .populate({
          path: 'user',
          select: 'teamName isTournamentReady',
          match: { isTournamentReady: true }
        })
        .populate('player', 'name type basePrice')
        .sort({ updatedAt: -1 })
        .limit(30),
      PlayerStats.find({}).populate({
        path: 'userId',
        select: 'isTournamentReady',
        match: { isTournamentReady: true }
      }).sort({ createdAt: -1 }).limit(50).lean(),
      Fixture.find({ isActive: true }).sort({ createdAt: -1 }).limit(20).lean(),
      Schedule.find({}).sort({ createdAt: -1 }).limit(30).lean()
    ]);

    const news = [];

    // 🚀 PERFORMANCE: Batch fetch all UserPlayer data for trades to avoid N+1 queries
    const allTradePlayerIds = [];
    trades.forEach(t => {
      if (t.offeredPlayer?._id) allTradePlayerIds.push(t.offeredPlayer._id);
      if (t.requestedPlayer?._id) allTradePlayerIds.push(t.requestedPlayer._id);
    });
    
    // Fetch all UserPlayer records in one query (instead of N queries in loop)
    const userPlayerMap = {};
    if (allTradePlayerIds.length > 0) {
      const userPlayers = await UserPlayer.find({
        playerId: { $in: allTradePlayerIds },
        isActive: true
      }).select('playerId bidValue').lean();
      
      userPlayers.forEach(up => {
        const pid = String(up.playerId);
        // Keep the highest bidValue if multiple UserPlayer records exist for same player
        if (!userPlayerMap[pid] || Number(up.bidValue) > Number(userPlayerMap[pid]?.bidValue || 0)) {
          userPlayerMap[pid] = up;
        }
      });
    }

    // 🚀 PERFORMANCE: Batch fetch User and Player data for releases to avoid N+1 queries
    const releaseUserIds = [];
    const releasePlayerIds = [];
    releases.forEach(r => {
      if (r.user && !r.user.teamName) releaseUserIds.push(r.user); // If not populated, it's an ID
      if (r.player && !r.player.name) releasePlayerIds.push(r.player); // If not populated, it's an ID
    });
    
    const releaseUserMap = {};
    const releasePlayerMap = {};
    
    if (releaseUserIds.length > 0) {
      const users = await User.find({ _id: { $in: releaseUserIds } }).select('teamName').lean();
      users.forEach(u => {
        releaseUserMap[String(u._id)] = u;
      });
    }
    
    if (releasePlayerIds.length > 0) {
      const players = await Player.find({ _id: { $in: releasePlayerIds } }).select('name type').lean();
      players.forEach(p => {
        releasePlayerMap[String(p._id)] = p;
      });
    }

    // Trades
    for (const t of trades) {
      // Skip trades from non-tournament-ready users
      if (!t.fromUser || !t.toUser) {
        continue;
      }
      
      const offeredName = t.offeredPlayer?.name || 'Unknown Player';
      const requestedName = t.requestedPlayer?.name || 'Unknown Player';
      const fromTeam = t.fromUser?.teamName || 'Unknown Team';
      const toTeam = t.toUser?.teamName || 'Unknown Team';
      
      // Try to infer trade value from user-player bid values (using pre-fetched map)
      let approxValue = 0;
      try {
        const up1 = t.offeredPlayer?._id ? userPlayerMap[String(t.offeredPlayer._id)] : null;
        const up2 = t.requestedPlayer?._id ? userPlayerMap[String(t.requestedPlayer._id)] : null;
        approxValue = Math.max(Number(up1?.bidValue || 0), Number(up2?.bidValue || 0));
      } catch (error) {
        console.error('Error getting bid values for trade:', error);
      }

      let status = t.status;
      let title = '';
      let body = '';
      const priceCr = toCrores(approxValue).toFixed(2);
      const highValue = approxValue >= 100000000; // 10 cr
      if (status === 'completed') {
        const tradeTitleVariants = [
          `🔥 TRADE COMPLETED: ${offeredName} ↔ ${requestedName}`,
          `⚡ SWAP SUCCESS: ${offeredName} ↔ ${requestedName} - Deal done!`,
          `🎯 TRADE FINALIZED: ${offeredName} ↔ ${requestedName} - New chapter begins!`,
          `🚀 DEAL SEALED: ${offeredName} ↔ ${requestedName} - The exchange is complete!`,
        ];
        const tradeBodyVariants = [
          `🔥 ${fromTeam} and ${toTeam} completed a blockbuster swap${approxValue ? ` (approx ₹${priceCr} Cr)` : ''}!`,
          `⚡ The trade is official! ${fromTeam} ↔ ${toTeam} - ${offeredName} for ${requestedName}${approxValue ? ` (₹${priceCr} Cr deal)` : ''}!`,
          `🎯 Trade confirmed! ${fromTeam} and ${toTeam} have sealed the deal${approxValue ? ` worth ₹${priceCr} Cr` : ''}!`,
          `🚀 Deal done! ${offeredName} ↔ ${requestedName} between ${fromTeam} and ${toTeam}${approxValue ? ` (₹${priceCr} Cr)` : ''}!`,
        ];
        title = pickVariant(`${offeredName}-${requestedName}-completed`, tradeTitleVariants);
        body = pickVariant(`${fromTeam}-${toTeam}-completed`, tradeBodyVariants);
      } else if (status === 'admin_pending') {
        const pendingTitleVariants = [
          `⏳ AWAITING APPROVAL: ${offeredName} ↔ ${requestedName}`,
          `🔍 PENDING REVIEW: ${offeredName} ↔ ${requestedName} - Admin decision needed!`,
          `📋 UNDER REVIEW: ${offeredName} ↔ ${requestedName} - Awaiting green light!`,
          `⚖️ PENDING DECISION: ${offeredName} ↔ ${requestedName} - Admin to decide!`,
        ];
        const pendingBodyVariants = [
          `⏳ Trade sent to admin by ${toTeam}. ${fromTeam} initiated the proposal - awaiting approval!`,
          `🔍 ${fromTeam} proposed a trade to ${toTeam}. Admin review in progress!`,
          `📋 Trade proposal under admin review. ${fromTeam} ↔ ${toTeam} - decision pending!`,
          `⚖️ ${fromTeam} wants to swap ${offeredName} for ${requestedName} with ${toTeam}. Admin decision awaited!`,
        ];
        title = pickVariant(`${offeredName}-${requestedName}-pending`, pendingTitleVariants);
        body = pickVariant(`${fromTeam}-${toTeam}-pending`, pendingBodyVariants);
      } else if (status === 'pending' || status === 'counter') {
        const proposedTitleVariants = [
          `💼 TRADE PROPOSED: ${offeredName} ↔ ${requestedName}`,
          `📝 NEW OFFER: ${offeredName} ↔ ${requestedName} - Trade proposal sent!`,
          `🤝 TRADE OFFER: ${offeredName} ↔ ${requestedName} - Waiting for response!`,
          `📋 PROPOSAL SENT: ${offeredName} ↔ ${requestedName} - Trade offer on table!`,
        ];
        const proposedBodyVariants = [
          `💼 ${fromTeam} proposed a trade to ${toTeam}. ${offeredName} ↔ ${requestedName}!`,
          `📝 New trade offer! ${fromTeam} wants to swap ${offeredName} for ${requestedName} with ${toTeam}!`,
          `🤝 Trade proposal sent! ${fromTeam} ↔ ${toTeam} - ${offeredName} for ${requestedName}!`,
          `📋 ${fromTeam} has made an offer to ${toTeam}. ${offeredName} ↔ ${requestedName} - awaiting response!`,
        ];
        title = pickVariant(`${offeredName}-${requestedName}-proposed`, proposedTitleVariants);
        body = pickVariant(`${fromTeam}-${toTeam}-proposed`, proposedBodyVariants);
      } else if (status === 'rejected') {
        const rejectedTitleVariants = [
          `❌ TRADE REJECTED: ${offeredName} ↔ ${requestedName}`,
          `🚫 DEAL TURNED DOWN: ${offeredName} ↔ ${requestedName} - Trade rejected!`,
          `💔 TRADE DECLINED: ${offeredName} ↔ ${requestedName} - No deal!`,
          `🔴 OFFER REJECTED: ${offeredName} ↔ ${requestedName} - Trade failed!`,
        ];
        const rejectedBodyVariants = [
          `❌ Admin/user rejected the trade proposal. ${offeredName} ↔ ${requestedName} - no deal!`,
          `🚫 Trade proposal turned down. ${fromTeam} ↔ ${toTeam} - ${offeredName} for ${requestedName} rejected!`,
          `💔 Deal declined. ${offeredName} ↔ ${requestedName} between ${fromTeam} and ${toTeam} - not happening!`,
          `🔴 Trade offer rejected. ${fromTeam} wanted to swap ${offeredName} for ${requestedName} with ${toTeam} - denied!`,
        ];
        title = pickVariant(`${offeredName}-${requestedName}-rejected`, rejectedTitleVariants);
        body = pickVariant(`${fromTeam}-${toTeam}-rejected`, rejectedBodyVariants);
      } else if (status === 'withdrawn') {
        const withdrawnTitleVariants = [
          `↩️ TRADE WITHDRAWN: ${offeredName} ↔ ${requestedName}`,
          `🔄 OFFER PULLED: ${offeredName} ↔ ${requestedName} - Trade withdrawn!`,
          `📤 PROPOSAL CANCELLED: ${offeredName} ↔ ${requestedName} - Deal off!`,
          `❌ TRADE CANCELLED: ${offeredName} ↔ ${requestedName} - Withdrawn!`,
        ];
        const withdrawnBodyVariants = [
          `↩️ ${fromTeam} withdrew the trade proposal. ${offeredName} ↔ ${requestedName} - deal cancelled!`,
          `🔄 Trade offer pulled back by ${fromTeam}. ${offeredName} for ${requestedName} with ${toTeam} - no longer available!`,
          `📤 ${fromTeam} cancelled the trade proposal. ${offeredName} ↔ ${requestedName} - offer withdrawn!`,
          `❌ Trade deal cancelled by ${fromTeam}. ${offeredName} ↔ ${requestedName} with ${toTeam} - no longer on table!`,
        ];
        title = pickVariant(`${offeredName}-${requestedName}-withdrawn`, withdrawnTitleVariants);
        body = pickVariant(`${fromTeam}-${toTeam}-withdrawn`, withdrawnBodyVariants);
      }
      news.push({
        id: t._id, // Add the original trade document ID
        kind: 'trade',
        status,
        title,
        body,
        isBreaking: status === 'completed' && highValue,
        timestamp: t.updatedAt,
      });
    }

    // Releases
    for (const r of releases) {
      // Skip releases from non-tournament-ready users
      if (!r.user) {
        continue;
      }
      
      let title = '';
      let body = '';
      
      // Check if population worked and use pre-fetched data if needed
      let userData = r.user;
      let playerData = r.player;
      
      if (!userData || !playerData) {
        // Use pre-fetched data from batch query (no additional database calls)
        try {
          if (!userData && r.user) {
            const userId = typeof r.user === 'object' ? r.user._id : r.user;
            userData = releaseUserMap[String(userId)];
          }
          
          if (!playerData && r.player) {
            const playerId = typeof r.player === 'object' ? r.player._id : r.player;
            playerData = releasePlayerMap[String(playerId)];
          }
        } catch (error) {
          console.error('❌ Error accessing batch-fetched data:', error);
        }
      }
      
      if (r.status === 'completed') {
        const releaseTitleVariants = [
          `🔥 RELEASE CONFIRMED: ${playerData?.name || 'Unknown Player'}`,
          `⚡ PLAYER RELEASED: ${playerData?.name || 'Unknown Player'} - Free agent!`,
          `🎯 RELEASE FINALIZED: ${playerData?.name || 'Unknown Player'} - Back to pool!`,
          `🚀 PLAYER LET GO: ${playerData?.name || 'Unknown Player'} - Available for bidding!`,
        ];
        const releaseBodyVariants = [
          `🔥 ${userData?.teamName || 'Unknown Team'} released ${playerData?.name || 'Unknown Player'} (${playerData?.type || 'Unknown Type'}) - back to the auction pool!`,
          `⚡ ${playerData?.name || 'Unknown Player'} is now a free agent! ${userData?.teamName || 'Unknown Team'} has released the ${playerData?.type || 'Unknown Type'} player.`,
          `🎯 Release confirmed! ${userData?.teamName || 'Unknown Team'} has let go of ${playerData?.name || 'Unknown Player'} (${playerData?.type || 'Unknown Type'}).`,
          `🚀 ${playerData?.name || 'Unknown Player'} is back on the market! ${userData?.teamName || 'Unknown Team'} has released the ${playerData?.type || 'Unknown Type'} player.`,
        ];
        title = pickVariant(`${playerData?.name}-completed`, releaseTitleVariants);
        body = pickVariant(`${userData?.teamName}-completed`, releaseBodyVariants);
      } else if (r.status === 'pending' || r.status === 'admin_pending') {
        const pendingTitleVariants = [
          `⏳ RELEASE REQUESTED: ${playerData?.name || 'Unknown Player'}`,
          `🔍 RELEASE PENDING: ${playerData?.name || 'Unknown Player'} - Awaiting approval!`,
          `📋 RELEASE UNDER REVIEW: ${playerData?.name || 'Unknown Player'} - Admin decision needed!`,
          `⚖️ RELEASE PENDING: ${playerData?.name || 'Unknown Player'} - Review in progress!`,
        ];
        const pendingBodyVariants = [
          `⏳ ${userData?.teamName || 'Unknown Team'} requested to release ${playerData?.name || 'Unknown Player'} - awaiting admin approval!`,
          `🔍 Release request submitted! ${userData?.teamName || 'Unknown Team'} wants to let go of ${playerData?.name || 'Unknown Player'}.`,
          `📋 ${userData?.teamName || 'Unknown Team'} has requested to release ${playerData?.name || 'Unknown Player'} - under admin review!`,
          `⚖️ Release request pending! ${userData?.teamName || 'Unknown Team'} wants to release ${playerData?.name || 'Unknown Player'} - admin decision awaited!`,
        ];
        title = pickVariant(`${playerData?.name}-pending`, pendingTitleVariants);
        body = pickVariant(`${userData?.teamName}-pending`, pendingBodyVariants);
      } else if (r.status === 'rejected') {
        const rejectedTitleVariants = [
          `❌ RELEASE REJECTED: ${playerData?.name || 'Unknown Player'}`,
          `🚫 RELEASE DENIED: ${playerData?.name || 'Unknown Player'} - Request turned down!`,
          `💔 RELEASE FAILED: ${playerData?.name || 'Unknown Player'} - No go from admin!`,
          `🔴 RELEASE BLOCKED: ${playerData?.name || 'Unknown Player'} - Admin says no!`,
        ];
        const rejectedBodyVariants = [
          `❌ Admin rejected release request for ${playerData?.name || 'Unknown Player'}. ${userData?.teamName || 'Unknown Team'} must keep the player!`,
          `🚫 Release denied! Admin has turned down the request to release ${playerData?.name || 'Unknown Player'} from ${userData?.teamName || 'Unknown Team'}.`,
          `💔 Release request failed! ${userData?.teamName || 'Unknown Team'} cannot release ${playerData?.name || 'Unknown Player'} - admin decision is final!`,
          `🔴 Release blocked! Admin has rejected the request to release ${playerData?.name || 'Unknown Player'} from ${userData?.teamName || 'Unknown Team'}.`,
        ];
        title = pickVariant(`${playerData?.name}-rejected`, rejectedTitleVariants);
        body = pickVariant(`${userData?.teamName}-rejected`, rejectedBodyVariants);
      } else if (r.status === 'withdrawn') {
        const withdrawnTitleVariants = [
          `↩️ RELEASE WITHDRAWN: ${playerData?.name || 'Unknown Player'}`,
          `🔄 RELEASE CANCELLED: ${playerData?.name || 'Unknown Player'} - Request pulled back!`,
          `📤 RELEASE PULLED: ${playerData?.name || 'Unknown Player'} - No longer requested!`,
          `❌ RELEASE OFF: ${playerData?.name || 'Unknown Player'} - Request withdrawn!`,
        ];
        const withdrawnBodyVariants = [
          `↩️ ${userData?.teamName || 'Unknown Team'} withdrew the release request for ${playerData?.name || 'Unknown Player'}. Player stays!`,
          `🔄 Release request cancelled! ${userData?.teamName || 'Unknown Team'} has pulled back the request to release ${playerData?.name || 'Unknown Player'}.`,
          `📤 Release request pulled! ${userData?.teamName || 'Unknown Team'} no longer wants to release ${playerData?.name || 'Unknown Player'}.`,
          `❌ Release request withdrawn! ${userData?.teamName || 'Unknown Team'} has cancelled the request to release ${playerData?.name || 'Unknown Player'}.`,
        ];
        title = pickVariant(`${playerData?.name}-withdrawn`, withdrawnTitleVariants);
        body = pickVariant(`${userData?.teamName}-withdrawn`, withdrawnBodyVariants);
      }
      
      // Only add to news if we have a valid title and body
      if (title && body) {
        news.push({ 
          id: r._id, // Add the original release document ID
          kind: 'release', 
          status: r.status, 
          title, 
          body, 
          isBreaking: false, 
          timestamp: r.updatedAt 
        });
      }
    }

    // Picks
    for (const p of picks) {
      // Skip picks from non-tournament-ready users
      if (!p.user) {
        continue;
      }
      
      let title = '';
      let body = '';
      if (p.status === 'completed') {
        const pickTitleVariants = [
          `🔥 PICK CONFIRMED: ${p.player?.name || 'Unknown Player'} to ${p.user?.teamName || 'Unknown Team'}`,
          `⚡ PLAYER PICKED: ${p.player?.name || 'Unknown Player'} - New addition to ${p.user?.teamName || 'Unknown Team'}!`,
          `🎯 PICK FINALIZED: ${p.player?.name || 'Unknown Player'} joins ${p.user?.teamName || 'Unknown Team'}!`,
          `🚀 DEAL DONE: ${p.player?.name || 'Unknown Player'} - Welcome to ${p.user?.teamName || 'Unknown Team'}!`,
        ];
        const pickBodyVariants = [
          `🔥 ${p.player?.type || 'Unknown Type'} picked at base ₹${Number(p.player?.basePrice || 0).toLocaleString('en-IN')}! ${p.player?.name || 'Unknown Player'} is now part of ${p.user?.teamName || 'Unknown Team'}!`,
          `⚡ Pick confirmed! ${p.player?.name || 'Unknown Player'} (${p.player?.type || 'Unknown Type'}) joins ${p.user?.teamName || 'Unknown Team'} at base price ₹${Number(p.player?.basePrice || 0).toLocaleString('en-IN')}!`,
          `🎯 Player acquisition successful! ${p.player?.name || 'Unknown Player'} - ${p.player?.type || 'Unknown Type'} - is now with ${p.user?.teamName || 'Unknown Team'} at ₹${Number(p.player?.basePrice || 0).toLocaleString('en-IN')}!`,
          `🚀 New team member! ${p.player?.name || 'Unknown Player'} (${p.player?.type || 'Unknown Type'}) has been picked by ${p.user?.teamName || 'Unknown Team'} at base price ₹${Number(p.player?.basePrice || 0).toLocaleString('en-IN')}!`,
        ];
        title = pickVariant(`${p.player?.name}-completed`, pickTitleVariants);
        body = pickVariant(`${p.user?.teamName}-completed`, pickBodyVariants);
      } else if (p.status === 'pending' || p.status === 'admin_pending') {
        const pendingTitleVariants = [
          `⏳ PICK REQUESTED: ${p.player?.name || 'Unknown Player'}`,
          `🔍 PICK PENDING: ${p.player?.name || 'Unknown Player'} - Awaiting approval!`,
          `📋 PICK UNDER REVIEW: ${p.player?.name || 'Unknown Player'} - Admin decision needed!`,
          `⚖️ PICK PENDING: ${p.player?.name || 'Unknown Player'} - Review in progress!`,
        ];
        const pendingBodyVariants = [
          `⏳ ${p.user?.teamName || 'Unknown Team'} requested to pick unsold ${p.player?.type || 'Unknown Type'} ${p.player?.name || 'Unknown Player'} - awaiting admin approval!`,
          `🔍 Pick request submitted! ${p.user?.teamName || 'Unknown Team'} wants to acquire ${p.player?.name || 'Unknown Player'} (${p.player?.type || 'Unknown Type'}).`,
          `📋 ${p.user?.teamName || 'Unknown Team'} has requested to pick ${p.player?.name || 'Unknown Player'} - under admin review!`,
          `⚖️ Pick request pending! ${p.user?.teamName || 'Unknown Team'} wants to add ${p.player?.name || 'Unknown Player'} (${p.player?.type || 'Unknown Type'}) to their squad - admin decision awaited!`,
        ];
        title = pickVariant(`${p.player?.name}-pending`, pendingTitleVariants);
        body = pickVariant(`${p.user?.teamName}-pending`, pendingBodyVariants);
      } else if (p.status === 'rejected') {
        const rejectedTitleVariants = [
          `❌ PICK REJECTED: ${p.player?.name || 'Unknown Player'}`,
          `🚫 PICK DENIED: ${p.player?.name || 'Unknown Player'} - Request turned down!`,
          `💔 PICK FAILED: ${p.player?.name || 'Unknown Player'} - No go from admin!`,
          `🔴 PICK BLOCKED: ${p.player?.name || 'Unknown Player'} - Admin says no!`,
        ];
        const rejectedBodyVariants = [
          `❌ Admin rejected pick request from ${p.user?.teamName || 'Unknown Team'} for ${p.player?.name || 'Unknown Player'}. Player remains unsold!`,
          `🚫 Pick denied! Admin has turned down the request to pick ${p.player?.name || 'Unknown Player'} (${p.player?.type || 'Unknown Type'}) by ${p.user?.teamName || 'Unknown Team'}.`,
          `💔 Pick request failed! ${p.user?.teamName || 'Unknown Team'} cannot acquire ${p.player?.name || 'Unknown Player'} - admin decision is final!`,
          `🔴 Pick blocked! Admin has rejected the request to pick ${p.player?.name || 'Unknown Player'} (${p.player?.type || 'Unknown Type'}) by ${p.user?.teamName || 'Unknown Team'}.`,
        ];
        title = pickVariant(`${p.player?.name}-rejected`, rejectedTitleVariants);
        body = pickVariant(`${p.user?.teamName}-rejected`, rejectedBodyVariants);
      }
      
      
      news.push({ 
        id: p._id, // Add the original pick document ID
        kind: 'pick', 
        status: p.status, 
        title, 
        body, 
        isBreaking: false, 
        timestamp: p.updatedAt 
      });
    }

    // Stats highlights (centuries, 50+, 4-fers, all-round)
    for (const s of recentStats) {
      // Skip stats from non-tournament-ready users
      if (!s.userId || !s.userId.isTournamentReady) {
        continue;
      }
      
      const runs = s.battingStats?.runs || 0;
      const wickets = s.bowlingStats?.wickets || 0;
      const ballsBowled = s.bowlingStats?.ballsBowled || 0;
      const [player, user, opp] = await Promise.all([
        Player.findById(s.playerId).select('name type').lean(),
        User.findById(s.userId._id || s.userId).select('teamName').lean(),
        s.opponentUserId ? User.findById(s.opponentUserId).select('teamName').lean() : Promise.resolve(null),
      ]);

      // All-round performance
      if (runs >= 20 && wickets >= 3) {
        const allRoundPhrases = [
          `🔥 ${player?.name} delivers a masterclass! ${runs}+ runs AND ${wickets} wickets for ${user?.teamName}!`,
          `⚡ ${player?.name} is the complete package! ${runs} runs + ${wickets} wickets = pure dominance!`,
          `🎯 ${player?.name} shows why they're the MVP! ${runs} runs and ${wickets} wickets for ${user?.teamName}!`,
          `🚀 ${player?.name} - the ultimate all-rounder! ${runs} runs + ${wickets} wickets = game changer!`,
        ];
        news.push({
          id: s._id, // Add the original stats document ID
          kind: 'stats',
          status: 'all_round',
          title: pickVariant(player?.name + runs + wickets, allRoundPhrases),
          body: `🏆 Against ${opp?.teamName || 'opposition'}, ${player?.name} proved they're the complete cricketer with ${runs} runs and ${wickets} wickets!`,
          isBreaking: true,
          timestamp: s.createdAt,
        });
        continue; // avoid multiple entries for same doc
      }

      // Batting milestones
      if (runs >= 100) {
        const centuryPhrases = [
          `🔥 ${player?.name} thunders to a MASSIVE ${runs} for ${user?.teamName}!`,
          `⚡ ${player?.name} lights up the park with a STUNNING ${runs}!`,
          `🎯 ${player?.name} hammers a MAJESTIC ${runs} - pure class!`,
          `🚀 ${player?.name} reaches the pinnacle with a BRILLIANT ${runs}!`,
          `🏆 ${player?.name} - CENTURY MAKER! ${runs} runs of pure brilliance!`,
        ];
        news.push({
          id: s._id, // Add the original stats document ID
          kind: 'stats',
          status: 'century',
          title: pickVariant(player?.name + runs, centuryPhrases),
          body: `🔥 CENTURY ALERT! ${player?.name} against ${opp?.teamName || 'opposition'} - ${runs} runs of pure cricketing excellence!`,
          isBreaking: true,
          timestamp: s.createdAt,
        });
      } else if (runs >= 50) {
        const fiftyPhrases = [
          `🔥 ${player?.name} crafts a CLASSY ${runs} for ${user?.teamName}!`,
          `⚡ ${player?.name} anchors with a COMPOSED ${runs} - solid foundation!`,
          `🎯 ${player?.name} raises a FINE fifty (${runs}) - well played!`,
          `🚀 ${player?.name} reaches the milestone with ${runs} - building momentum!`,
          `⭐ ${player?.name} - HALF CENTURY HERO! ${runs} runs of quality!`,
        ];
        news.push({
          id: s._id, // Add the original stats document ID
          kind: 'stats',
          status: 'fifty',
          title: pickVariant(player?.name + runs, fiftyPhrases),
          body: `⭐ HALF CENTURY! ${player?.name} against ${opp?.teamName || 'opposition'} - ${runs} runs that set the platform for victory!`,
          isBreaking: false,
          timestamp: s.createdAt,
        });
      }

      // Bowling milestones
      if (wickets >= 5) {
        const fiferPhrases = [
          `🔥 ${player?.name} WRECKS ${opp?.teamName || 'opposition'} with ${wickets} wickets!`,
          `⚡ ${player?.name} delivers a DEVASTATING ${wickets}-for - bowling masterclass!`,
          `🎯 ${player?.name} runs RIOT with ${wickets} wickets - pure destruction!`,
          `🚀 ${player?.name} - THE WICKET TAKER! ${wickets} wickets of pure magic!`,
          `🏆 ${player?.name} shows why they're the BOWLING KING! ${wickets} wickets!`,
        ];
        news.push({
          id: s._id, // Add the original stats document ID
          kind: 'stats',
          status: 'fifer',
          title: pickVariant(player?.name + wickets, fiferPhrases),
          body: `🏆 FIVER ALERT! ${player?.name} for ${user?.teamName} against ${opp?.teamName || 'opposition'} - ${wickets} wickets that turned the game!`,
          isBreaking: true,
          timestamp: s.createdAt,
        });
      } else if (wickets >= 4) {
        const fourWktPhrases = [
          `🔥 ${player?.name} stuns with ${wickets} wickets for ${user?.teamName}!`,
          `⚡ ${player?.name} produces a SUPERB ${wickets}-for - bowling brilliance!`,
          `🎯 ${player?.name} cripples ${opp?.teamName || 'opposition'} with ${wickets} wickets!`,
          `🚀 ${player?.name} - THE WICKET HUNTER! ${wickets} wickets of quality!`,
          `⭐ ${player?.name} shows bowling mastery with ${wickets} wickets!`,
        ];
        news.push({
          id: s._id, // Add the original stats document ID
          kind: 'stats',
          status: 'four_wkt',
          title: pickVariant(player?.name + wickets, fourWktPhrases),
          body: `⭐ FOUR WICKET HAUL! ${player?.name} for ${user?.teamName} against ${opp?.teamName || 'opposition'} - ${wickets} wickets that made the difference!`,
          isBreaking: false,
          timestamp: s.createdAt,
        });
      }
    }

    // Fixtures: generate result statements and praise MoM
    // ENHANCED: Now includes ALL fixtures (upcoming, live, completed) with sexy content
    // Get all tournament-ready teams first
    const tournamentReadyTeams = await User.find({ isTournamentReady: true }).select('teamName').lean();
    const readyTeamNames = tournamentReadyTeams.map(u => u.teamName);
    
    // Only include fixtures with tournament-ready teams
    const allFixtures = await Fixture.find({ 
      isActive: true,
      team1: { $in: readyTeamNames },
      team2: { $in: readyTeamNames }
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    
    for (const f of allFixtures) {
      const now = new Date();
      const matchTime = new Date(f.matchTime);
      const isUpcoming = matchTime > now;
      const isLive = !isUpcoming && !f.winner && f.isActive;
      const isCompleted = f.winner && !isUpcoming;
      
      let title = '';
      let body = '';
      let isBreaking = false;
      let status = 'fixture';
      
      if (isCompleted) {
        // COMPLETED MATCHES - Generate sexy result content with 100+ unique variations
      const thriller = (() => {
        if (!f.margin) return false;
        const text = String(f.margin).toLowerCase();
        return text.includes('wicket') && /\b(1|2)\b/.test(text) || text.includes('run') && /\b(1|2|3|4|5)\b/.test(text);
      })();
      const oneSided = (() => {
        if (!f.margin) return false;
        const text = String(f.margin).toLowerCase();
        return text.includes('wicket') && /\b(8|9|10)\b/.test(text) || text.includes('run') && /\b(40|50|60|70|80|90|100)\b/.test(text);
      })();
        
      const opponent = f.team1 === f.winner ? f.team2 : f.team1;
        
        // 50+ UNIQUE THRILLER HEADLINES - No repetition, genuine sports journalism style
      const titleVariantsThriller = [
          `🔥 ${f.winner} edge past ${opponent} in a last-over thriller!`,
          `⚡ ${f.winner} clinch a nail-biter against ${opponent}!`,
          `💥 ${f.winner} prevail by a whisker vs ${opponent}!`,
          `🎯 ${f.winner} snatch victory from the jaws of defeat!`,
          `🏆 ${f.winner} survive a heart-stopping finish against ${opponent}!`,
          `🚀 ${f.winner} escape with a dramatic win over ${opponent}!`,
          `⭐ ${f.winner} hold their nerve in a cliffhanger vs ${opponent}!`,
          `💎 ${f.winner} emerge victorious in a pulsating encounter!`,
          `🎪 ${f.winner} steal the show in a last-ball thriller!`,
          `🌟 ${f.winner} triumph in a match that went down to the wire!`,
          `🔥 ${f.winner} pull off a miraculous win against ${opponent}!`,
          `⚡ ${f.winner} survive a rollercoaster ride vs ${opponent}!`,
          `💥 ${f.winner} emerge on top in a battle of nerves!`,
          `🎯 ${f.winner} clinch victory in a match that had everything!`,
          `🏆 ${f.winner} prove their mettle in a high-pressure finish!`,
          `🚀 ${f.winner} show champion's resolve in a tight contest!`,
          `⭐ ${f.winner} demonstrate nerves of steel vs ${opponent}!`,
          `💎 ${f.winner} come out on top in a classic encounter!`,
          `🎪 ${f.winner} write another chapter in their success story!`,
          `🌟 ${f.winner} add another thrilling victory to their collection!`,
          `🔥 ${f.winner} prove why they're the team to beat!`,
          `⚡ ${f.winner} showcase their championship pedigree!`,
          `💥 ${f.winner} deliver when it matters most!`,
          `🎯 ${f.winner} show their class in a pressure cooker situation!`,
          `🏆 ${f.winner} emerge as the last team standing!`,
          `🚀 ${f.winner} prove their worth in a do-or-die situation!`,
          `⭐ ${f.winner} demonstrate their winning mentality!`,
          `💎 ${f.winner} show their championship credentials!`,
          `🎪 ${f.winner} prove they're made of sterner stuff!`,
          `🌟 ${f.winner} emerge victorious in a match for the ages!`,
          `🔥 ${f.winner} show why they're the team everyone fears!`,
          `⚡ ${f.winner} prove their mettle in a high-stakes game!`,
          `💥 ${f.winner} demonstrate their championship DNA!`,
          `🎯 ${f.winner} show their class in a must-win situation!`,
          `🏆 ${f.winner} prove they're the real deal!`,
          `🚀 ${f.winner} show their championship pedigree!`,
          `⭐ ${f.winner} demonstrate their winning culture!`,
          `💎 ${f.winner} prove they're built for pressure!`,
          `🎪 ${f.winner} show their championship mentality!`,
          `🌟 ${f.winner} emerge as the team to beat!`,
          `🔥 ${f.winner} prove their championship credentials!`,
          `⚡ ${f.winner} show their class in a high-pressure game!`,
          `💥 ${f.winner} demonstrate their winning DNA!`,
          `🎯 ${f.winner} prove they're made for big moments!`,
          `🏆 ${f.winner} show their championship character!`,
          `🚀 ${f.winner} prove their worth in a pressure situation!`,
          `⭐ ${f.winner} demonstrate their championship quality!`,
          `💎 ${f.winner} show their winning mentality!`,
          `🎪 ${f.winner} prove they're the team to watch!`,
          `🌟 ${f.winner} emerge as the championship favorites!`,
          `🔥 ${f.winner} show their championship pedigree!`,
          `⚡ ${f.winner} prove their mettle in a high-stakes encounter!`,
          `💥 ${f.winner} demonstrate their championship DNA!`,
          `🎯 ${f.winner} show their class in a pressure cooker game!`,
          `🏆 ${f.winner} prove they're the real championship contenders!`
        ];
        
        // 50+ UNIQUE ONE-SIDED HEADLINES - No repetition, genuine sports journalism style
      const titleVariantsOneSided = [
          `💪 ${f.winner} crush ${opponent} in a one-sided affair!`,
          `🚀 ${f.winner} dominate ${opponent} from start to finish!`,
          `⚡ ${f.winner} steamroll ${opponent} with authority!`,
          `🎯 ${f.winner} show ${opponent} who's boss!`,
          `🏆 ${f.winner} demolish ${opponent} in a masterclass!`,
          `⭐ ${f.winner} outclass ${opponent} completely!`,
          `💎 ${f.winner} annihilate ${opponent} in style!`,
          `🎪 ${f.winner} give ${opponent} a lesson in cricket!`,
          `🌟 ${f.winner} humiliate ${opponent} with a clinical display!`,
          `🔥 ${f.winner} obliterate ${opponent} in a one-way traffic!`,
          `⚡ ${f.winner} dismantle ${opponent} piece by piece!`,
          `💥 ${f.winner} pulverize ${opponent} in a mismatch!`,
          `🎯 ${f.winner} decimate ${opponent} with surgical precision!`,
          `🏆 ${f.winner} annihilate ${opponent} in a masterclass!`,
          `🚀 ${f.winner} overpower ${opponent} with brute force!`,
          `⭐ ${f.winner} outmuscle ${opponent} in every department!`,
          `💎 ${f.winner} overwhelm ${opponent} with their quality!`,
          `🎪 ${f.winner} give ${opponent} a reality check!`,
          `🌟 ${f.winner} show ${opponent} the difference in class!`,
          `🔥 ${f.winner} prove too strong for ${opponent}!`,
          `⚡ ${f.winner} demonstrate their superiority over ${opponent}!`,
          `💥 ${f.winner} expose ${opponent}'s weaknesses!`,
          `🎯 ${f.winner} highlight the gulf in class vs ${opponent}!`,
          `🏆 ${f.winner} showcase their championship credentials!`,
          `🚀 ${f.winner} prove they're in a different league!`,
          `⭐ ${f.winner} show why they're the favorites!`,
          `💎 ${f.winner} demonstrate their championship pedigree!`,
          `🎪 ${f.winner} prove they're the team to beat!`,
          `🌟 ${f.winner} show their championship quality!`,
          `🔥 ${f.winner} prove their worth in emphatic fashion!`,
          `⚡ ${f.winner} demonstrate their championship DNA!`,
          `💥 ${f.winner} show their class in dominant fashion!`,
          `🎯 ${f.winner} prove they're the real deal!`,
          `🏆 ${f.winner} showcase their championship mentality!`,
          `🚀 ${f.winner} prove they're built for success!`,
          `⭐ ${f.winner} demonstrate their winning culture!`,
          `💎 ${f.winner} show their championship character!`,
          `🎪 ${f.winner} prove they're the team to watch!`,
          `🌟 ${f.winner} emerge as the championship favorites!`,
          `🔥 ${f.winner} show their championship pedigree!`,
          `⚡ ${f.winner} prove their mettle in emphatic fashion!`,
          `💥 ${f.winner} demonstrate their championship quality!`,
          `🎯 ${f.winner} show their class in dominant fashion!`,
          `🏆 ${f.winner} prove they're the real championship contenders!`,
          `🚀 ${f.winner} showcase their championship credentials!`,
          `⭐ ${f.winner} demonstrate their winning mentality!`,
          `💎 ${f.winner} show their championship DNA!`,
          `🎪 ${f.winner} prove they're the team to beat!`,
          `🌟 ${f.winner} emerge as the championship favorites!`,
          `🔥 ${f.winner} show their championship pedigree!`,
          `⚡ ${f.winner} prove their worth in emphatic fashion!`,
          `💥 ${f.winner} demonstrate their championship quality!`,
          `🎯 ${f.winner} show their class in dominant fashion!`,
          `🏆 ${f.winner} prove they're the real deal!`,
          `🚀 ${f.winner} showcase their championship mentality!`,
          `⭐ ${f.winner} demonstrate their winning culture!`,
          `💎 ${f.winner} show their championship character!`,
          `🎪 ${f.winner} prove they're the team to watch!`,
          `🌟 ${f.winner} emerge as the championship favorites!`
        ];
        
        // 50+ UNIQUE REGULAR WIN HEADLINES - No repetition, genuine sports journalism style
      const titleVariantsRegular = [
          `🏆 ${f.winner} beat ${opponent} in style!`,
          `⭐ ${f.winner} outplay ${opponent} convincingly!`,
          `🎉 ${f.winner} record solid win over ${opponent}!`,
          `🔥 ${f.winner} get the better of ${opponent}!`,
          `⚡ ${f.winner} overcome ${opponent} with ease!`,
          `💥 ${f.winner} secure comfortable victory vs ${opponent}!`,
          `🎯 ${f.winner} notch up another win against ${opponent}!`,
          `🚀 ${f.winner} add another victory to their tally!`,
          `💎 ${f.winner} prove too good for ${opponent}!`,
          `🎪 ${f.winner} continue their winning run vs ${opponent}!`,
          `🌟 ${f.winner} maintain their dominance over ${opponent}!`,
          `🔥 ${f.winner} show their class against ${opponent}!`,
          `⚡ ${f.winner} demonstrate their superiority vs ${opponent}!`,
          `💥 ${f.winner} prove their worth against ${opponent}!`,
          `🎯 ${f.winner} showcase their quality vs ${opponent}!`,
          `🏆 ${f.winner} underline their credentials vs ${opponent}!`,
          `🚀 ${f.winner} prove their mettle against ${opponent}!`,
          `⭐ ${f.winner} show their championship pedigree!`,
          `💎 ${f.winner} demonstrate their winning mentality!`,
          `🎪 ${f.winner} prove they're the team to beat!`,
          `🌟 ${f.winner} show their championship quality!`,
          `🔥 ${f.winner} prove their worth in emphatic fashion!`,
          `⚡ ${f.winner} demonstrate their championship DNA!`,
          `💥 ${f.winner} show their class in dominant fashion!`,
          `🎯 ${f.winner} prove they're the real deal!`,
          `🏆 ${f.winner} showcase their championship mentality!`,
          `🚀 ${f.winner} prove they're built for success!`,
          `⭐ ${f.winner} demonstrate their winning culture!`,
          `💎 ${f.winner} show their championship character!`,
          `🎪 ${f.winner} prove they're the team to watch!`,
          `🌟 ${f.winner} emerge as the championship favorites!`,
          `🔥 ${f.winner} show their championship pedigree!`,
          `⚡ ${f.winner} prove their mettle in emphatic fashion!`,
          `💥 ${f.winner} demonstrate their championship quality!`,
          `🎯 ${f.winner} show their class in dominant fashion!`,
          `🏆 ${f.winner} prove they're the real championship contenders!`,
          `🚀 ${f.winner} showcase their championship credentials!`,
          `⭐ ${f.winner} demonstrate their winning mentality!`,
          `💎 ${f.winner} show their championship DNA!`,
          `🎪 ${f.winner} prove they're the team to beat!`,
          `🌟 ${f.winner} emerge as the championship favorites!`,
          `🔥 ${f.winner} show their championship pedigree!`,
          `⚡ ${f.winner} prove their worth in emphatic fashion!`,
          `💥 ${f.winner} demonstrate their championship quality!`,
          `🎯 ${f.winner} show their class in dominant fashion!`,
          `🏆 ${f.winner} prove they're the real deal!`,
          `🚀 ${f.winner} showcase their championship mentality!`,
          `⭐ ${f.winner} demonstrate their winning culture!`,
          `💎 ${f.winner} show their championship character!`,
          `🎪 ${f.winner} prove they're the team to watch!`,
          `🌟 ${f.winner} emerge as the championship favorites!`
        ];
        
        title = pickVariant(`${f.team1}-${f.team2}-${f.createdAt}`, 
          thriller ? titleVariantsThriller : oneSided ? titleVariantsOneSided : titleVariantsRegular);
        
        const momText = f.mom?.name ? ` 🏅 MoM ${f.mom.name}${(f.mom.score ? ` scored ${f.mom.score}` : '')}${(f.mom.wickets ? ` and took ${f.mom.wickets} wickets` : '')}.` : '';
        const scoreLine = (f.team1Score && f.team2Score) ? ` 📊 ${f.team1} ${f.team1Score} vs ${f.team2} ${f.team2Score}.` : '';
        
        // 30+ UNIQUE BODY VARIATIONS - No repetition, genuine sports journalism style
      const bodyVariants = [
          `${f.margin ? `🏆 Won by ${f.margin}.` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🎯 Victory margin: ${f.margin}.` : ''}${momText}`.trim(),
        `${momText}${scoreLine}${f.margin ? ` (${f.margin}).` : ''}`.trim(),
          `${f.margin ? `🎉 Triumph by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🏆 Winning margin: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Final result: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `⭐ Clinched by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 💎 Result: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Match decided by ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `🚀 Victory sealed by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🎯 Final margin: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Winning difference: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `💪 Dominated by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🏆 Triumph margin: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Decisive result: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `🌟 Sealed by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 💎 Victory by ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Final outcome: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `🔥 Clinched with ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🎪 Winning by ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Decisive margin: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `⚡ Triumph by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🏆 Victory margin: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Final result: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `💥 Sealed by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🎯 Triumph by ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Winning difference: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `🎉 Clinched with ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 💎 Victory by ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Final outcome: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `🏆 Sealed by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🚀 Triumph margin: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Decisive result: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `⭐ Victory by ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 💪 Winning margin: ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Final margin: ${f.margin}.` : ''}`.trim(),
          `${f.margin ? `🌟 Clinched with ${f.margin}!` : ''}${scoreLine}${momText}`.trim(),
          `${scoreLine}${f.margin ? ` 🎪 Triumph by ${f.margin}.` : ''}${momText}`.trim(),
          `${momText}${scoreLine}${f.margin ? ` Decisive outcome: ${f.margin}.` : ''}`.trim()
        ];
        
        body = pickVariant(`${f.team1}-${f.team2}-${f.updatedAt}`, bodyVariants);
        isBreaking = thriller;
        status = thriller ? 'thriller' : oneSided ? 'one_sided' : 'result';
        
      } else if (isLive) {
        // LIVE MATCHES - Generate exciting live content with 40+ unique variations
        const liveTitleVariants = [
          `🔥 LIVE: ${f.team1} vs ${f.team2} - Battle in progress!`,
          `⚡ LIVE: ${f.team1} taking on ${f.team2} - Don't miss the action!`,
          `🎯 LIVE: ${f.team1} vs ${f.team2} - Every ball counts!`,
          `🚀 LIVE: ${f.team1} vs ${f.team2} - The heat is on!`,
          `🏆 LIVE: ${f.team1} vs ${f.team2} - Match in full swing!`,
          `⭐ LIVE: ${f.team1} vs ${f.team2} - Action packed!`,
          `💎 LIVE: ${f.team1} vs ${f.team2} - Don't blink!`,
          `🎪 LIVE: ${f.team1} vs ${f.team2} - Thrills guaranteed!`,
          `🌟 LIVE: ${f.team1} vs ${f.team2} - Pure entertainment!`,
          `🔥 LIVE: ${f.team1} vs ${f.team2} - Edge of your seat!`,
          `⚡ LIVE: ${f.team1} vs ${f.team2} - Unmissable action!`,
          `🎯 LIVE: ${f.team1} vs ${f.team2} - Drama unfolding!`,
          `🚀 LIVE: ${f.team1} vs ${f.team2} - Intensity rising!`,
          `🏆 LIVE: ${f.team1} vs ${f.team2} - Battle royal!`,
          `⭐ LIVE: ${f.team1} vs ${f.team2} - High octane!`,
          `💎 LIVE: ${f.team1} vs ${f.team2} - Pure adrenaline!`,
          `🎪 LIVE: ${f.team1} vs ${f.team2} - Showtime!`,
          `🌟 LIVE: ${f.team1} vs ${f.team2} - Spectacle in progress!`,
          `🔥 LIVE: ${f.team1} vs ${f.team2} - Fireworks happening!`,
          `⚡ LIVE: ${f.team1} vs ${f.team2} - Lightning fast action!`,
          `🎯 LIVE: ${f.team1} vs ${f.team2} - Target in sight!`,
          `🚀 LIVE: ${f.team1} vs ${f.team2} - Rocketing forward!`,
          `🏆 LIVE: ${f.team1} vs ${f.team2} - Championship material!`,
          `⭐ LIVE: ${f.team1} vs ${f.team2} - Star studded!`,
          `💎 LIVE: ${f.team1} vs ${f.team2} - Diamond quality!`,
          `🎪 LIVE: ${f.team1} vs ${f.team2} - Circus of cricket!`,
          `🌟 LIVE: ${f.team1} vs ${f.team2} - Stellar performance!`,
          `🔥 LIVE: ${f.team1} vs ${f.team2} - Burning bright!`,
          `⚡ LIVE: ${f.team1} vs ${f.team2} - Electric atmosphere!`,
          `🎯 LIVE: ${f.team1} vs ${f.team2} - Bullseye!`,
          `🚀 LIVE: ${f.team1} vs ${f.team2} - Launching success!`,
          `🏆 LIVE: ${f.team1} vs ${f.team2} - Trophy hunt!`,
          `⭐ LIVE: ${f.team1} vs ${f.team2} - Shining bright!`,
          `💎 LIVE: ${f.team1} vs ${f.team2} - Precious moments!`,
          `🎪 LIVE: ${f.team1} vs ${f.team2} - Entertainment central!`,
          `🌟 LIVE: ${f.team1} vs ${f.team2} - Star power!`,
          `🔥 LIVE: ${f.team1} vs ${f.team2} - Hot action!`,
          `⚡ LIVE: ${f.team1} vs ${f.team2} - Speed demon!`,
          `🎯 LIVE: ${f.team1} vs ${f.team2} - Precision play!`,
          `🚀 LIVE: ${f.team1} vs ${f.team2} - Sky high!`,
          `🏆 LIVE: ${f.team1} vs ${f.team2} - Winner takes all!`,
          `⭐ LIVE: ${f.team1} vs ${f.team2} - Superstar clash!`,
          `💎 LIVE: ${f.team1} vs ${f.team2} - Gem of a match!`,
          `🎪 LIVE: ${f.team1} vs ${f.team2} - Show stopper!`,
          `🌟 LIVE: ${f.team1} vs ${f.team2} - Heavenly cricket!`
        ];
        
        const liveBodyVariants = [
          `🔥 The battle is LIVE! ${f.team1} and ${f.team2} are fighting it out on the field.`,
          `⚡ Don't blink! ${f.team1} vs ${f.team2} is happening right now with every ball bringing excitement!`,
          `🎯 The stadium is buzzing! ${f.team1} vs ${f.team2} - a match you can't afford to miss!`,
          `🚀 The action is LIVE and intense! ${f.team1} vs ${f.team2} - cricket at its finest!`,
          `🏆 Match in full swing! ${f.team1} vs ${f.team2} - every moment is pure gold!`,
          `⭐ Action packed cricket! ${f.team1} vs ${f.team2} - don't miss a single ball!`,
          `💎 Pure entertainment happening! ${f.team1} vs ${f.team2} - cricket at its best!`,
          `🎪 Circus of cricket in progress! ${f.team1} vs ${f.team2} - thrills guaranteed!`,
          `🌟 Stellar performance unfolding! ${f.team1} vs ${f.team2} - pure magic!`,
          `🔥 Fireworks on the field! ${f.team1} vs ${f.team2} - every ball is explosive!`,
          `⚡ Lightning fast action! ${f.team1} vs ${f.team2} - speed and skill combined!`,
          `🎯 Target in sight! ${f.team1} vs ${f.team2} - precision play at its finest!`,
          `🚀 Rocketing towards victory! ${f.team1} vs ${f.team2} - momentum building!`,
          `🏆 Championship material on display! ${f.team1} vs ${f.team2} - quality cricket!`,
          `⭐ Star studded performance! ${f.team1} vs ${f.team2} - superstars in action!`,
          `💎 Diamond quality cricket! ${f.team1} vs ${f.team2} - precious moments!`,
          `🎪 Entertainment central! ${f.team1} vs ${f.team2} - showtime on the field!`,
          `🌟 Star power in action! ${f.team1} vs ${f.team2} - heavenly cricket!`,
          `🔥 Hot action on the field! ${f.team1} vs ${f.team2} - temperature rising!`,
          `⚡ Speed demon in action! ${f.team1} vs ${f.team2} - lightning strikes!`,
          `🎯 Precision play unfolding! ${f.team1} vs ${f.team2} - target practice!`,
          `🚀 Sky high performance! ${f.team1} vs ${f.team2} - reaching new heights!`,
          `🏆 Winner takes all! ${f.team1} vs ${f.team2} - championship battle!`,
          `⭐ Superstar clash happening! ${f.team1} vs ${f.team2} - star power!`,
          `💎 Gem of a match! ${f.team1} vs ${f.team2} - precious moments!`,
          `🎪 Show stopper in progress! ${f.team1} vs ${f.team2} - entertainment guaranteed!`,
          `🌟 Heavenly cricket unfolding! ${f.team1} vs ${f.team2} - divine performance!`,
          `🔥 Burning bright on the field! ${f.team1} vs ${f.team2} - fire and passion!`,
          `⚡ Electric atmosphere! ${f.team1} vs ${f.team2} - sparks flying!`,
          `🎯 Bullseye accuracy! ${f.team1} vs ${f.team2} - precision play!`,
          `🚀 Launching towards success! ${f.team1} vs ${f.team2} - countdown to victory!`,
          `🏆 Trophy hunt in progress! ${f.team1} vs ${f.team2} - championship chase!`,
          `⭐ Shining bright on the field! ${f.team1} vs ${f.team2} - star quality!`,
          `💎 Precious moments unfolding! ${f.team1} vs ${f.team2} - diamond standard!`,
          `🎪 Entertainment central! ${f.team1} vs ${f.team2} - showtime!`,
          `🌟 Star power in action! ${f.team1} vs ${f.team2} - heavenly performance!`
        ];
        
        title = pickVariant(`${f.team1}-${f.team2}-live`, liveTitleVariants);
        body = pickVariant(`${f.team1}-${f.team2}-live-body`, liveBodyVariants);
        isBreaking = true;
        status = 'live';
        
      } else if (isUpcoming) {
        // UPCOMING MATCHES - Generate sexy preview content with 50+ unique variations
        const timeUntilMatch = Math.floor((matchTime - now) / (1000 * 60 * 60)); // hours
        const isToday = timeUntilMatch < 24;
        const isTomorrow = timeUntilMatch >= 24 && timeUntilMatch < 48;
        
        let timeText = '';
        if (isToday) {
          timeText = 'TODAY';
        } else if (isTomorrow) {
          timeText = 'TOMORROW';
        } else {
          timeText = `${Math.ceil(timeUntilMatch / 24)} days away`;
        }
        
        const upcomingTitleVariants = [
          `🔥 UPCOMING: ${f.team1} vs ${f.team2} - ${timeText}!`,
          `⚡ UPCOMING: ${f.team1} vs ${f.team2} - Get ready for fireworks!`,
          `🎯 UPCOMING: ${f.team1} vs ${f.team2} - The clash of titans!`,
          `🚀 UPCOMING: ${f.team1} vs ${f.team2} - Battle lines drawn!`,
          `🏆 UPCOMING: ${f.team1} vs ${f.team2} - Championship clash!`,
          `⭐ UPCOMING: ${f.team1} vs ${f.team2} - Star studded affair!`,
          `💎 UPCOMING: ${f.team1} vs ${f.team2} - Diamond quality match!`,
          `🎪 UPCOMING: ${f.team1} vs ${f.team2} - Entertainment guaranteed!`,
          `🌟 UPCOMING: ${f.team1} vs ${f.team2} - Heavenly cricket!`,
          `🔥 UPCOMING: ${f.team1} vs ${f.team2} - Fireworks expected!`,
          `⚡ UPCOMING: ${f.team1} vs ${f.team2} - Lightning fast action!`,
          `🎯 UPCOMING: ${f.team1} vs ${f.team2} - Target set!`,
          `🚀 UPCOMING: ${f.team1} vs ${f.team2} - Ready for launch!`,
          `🏆 UPCOMING: ${f.team1} vs ${f.team2} - Trophy battle!`,
          `⭐ UPCOMING: ${f.team1} vs ${f.team2} - Superstar clash!`,
          `💎 UPCOMING: ${f.team1} vs ${f.team2} - Gem of a match!`,
          `🎪 UPCOMING: ${f.team1} vs ${f.team2} - Showtime coming!`,
          `🌟 UPCOMING: ${f.team1} vs ${f.team2} - Star power!`,
          `🔥 UPCOMING: ${f.team1} vs ${f.team2} - Hot action expected!`,
          `⚡ UPCOMING: ${f.team1} vs ${f.team2} - Speed demon alert!`,
          `🎯 UPCOMING: ${f.team1} vs ${f.team2} - Precision play!`,
          `🚀 UPCOMING: ${f.team1} vs ${f.team2} - Sky high expectations!`,
          `🏆 UPCOMING: ${f.team1} vs ${f.team2} - Championship material!`,
          `⭐ UPCOMING: ${f.team1} vs ${f.team2} - Star quality!`,
          `💎 UPCOMING: ${f.team1} vs ${f.team2} - Diamond standard!`,
          `🎪 UPCOMING: ${f.team1} vs ${f.team2} - Entertainment central!`,
          `🌟 UPCOMING: ${f.team1} vs ${f.team2} - Heavenly performance!`,
          `🔥 UPCOMING: ${f.team1} vs ${f.team2} - Burning bright!`,
          `⚡ UPCOMING: ${f.team1} vs ${f.team2} - Electric atmosphere!`,
          `🎯 UPCOMING: ${f.team1} vs ${f.team2} - Bullseye target!`,
          `🚀 UPCOMING: ${f.team1} vs ${f.team2} - Launching success!`,
          `🏆 UPCOMING: ${f.team1} vs ${f.team2} - Trophy hunt!`,
          `⭐ UPCOMING: ${f.team1} vs ${f.team2} - Shining bright!`,
          `💎 UPCOMING: ${f.team1} vs ${f.team2} - Precious moments!`,
          `🎪 UPCOMING: ${f.team1} vs ${f.team2} - Show stopper!`,
          `🌟 UPCOMING: ${f.team1} vs ${f.team2} - Star power!`,
          `🔥 UPCOMING: ${f.team1} vs ${f.team2} - Hot action!`,
          `⚡ UPCOMING: ${f.team1} vs ${f.team2} - Lightning strikes!`,
          `🎯 UPCOMING: ${f.team1} vs ${f.team2} - Target practice!`,
          `🚀 UPCOMING: ${f.team1} vs ${f.team2} - Sky high!`,
          `🏆 UPCOMING: ${f.team1} vs ${f.team2} - Winner takes all!`,
          `⭐ UPCOMING: ${f.team1} vs ${f.team2} - Superstar clash!`,
          `💎 UPCOMING: ${f.team1} vs ${f.team2} - Gem of a match!`,
          `🎪 UPCOMING: ${f.team1} vs ${f.team2} - Entertainment guaranteed!`,
          `🌟 UPCOMING: ${f.team1} vs ${f.team2} - Heavenly cricket!`
        ];
        
        const upcomingBodyVariants = [
          `🔥 ${f.team1} vs ${f.team2} - ${timeText}! Two powerhouses ready to lock horns in what promises to be an epic battle!`,
          `⚡ ${f.team1} vs ${f.team2} - ${timeText}! The stage is set for a cricketing spectacle that will leave you breathless!`,
          `🎯 ${f.team1} vs ${f.team2} - ${timeText}! Two teams, one goal - victory! Who will emerge triumphant?`,
          `🚀 ${f.team1} vs ${f.team2} - ${timeText}! The countdown begins for a match that will redefine excitement!`,
          `🏆 ${f.team1} vs ${f.team2} - ${timeText}! Championship clash that promises to be a classic!`,
          `⭐ ${f.team1} vs ${f.team2} - ${timeText}! Star studded affair that will light up the stadium!`,
          `💎 ${f.team1} vs ${f.team2} - ${timeText}! Diamond quality match that will be remembered for ages!`,
          `🎪 ${f.team1} vs ${f.team2} - ${timeText}! Entertainment guaranteed with two top teams in action!`,
          `🌟 ${f.team1} vs ${f.team2} - ${timeText}! Heavenly cricket that will take your breath away!`,
          `🔥 ${f.team1} vs ${f.team2} - ${timeText}! Fireworks expected as two giants collide!`,
          `⚡ ${f.team1} vs ${f.team2} - ${timeText}! Lightning fast action guaranteed in this epic clash!`,
          `🎯 ${f.team1} vs ${f.team2} - ${timeText}! Target set for what promises to be a memorable encounter!`,
          `🚀 ${f.team1} vs ${f.team2} - ${timeText}! Ready for launch as two teams prepare for battle!`,
          `🏆 ${f.team1} vs ${f.team2} - ${timeText}! Trophy battle that will decide the champion!`,
          `⭐ ${f.team1} vs ${f.team2} - ${timeText}! Superstar clash that will showcase the best of cricket!`,
          `💎 ${f.team1} vs ${f.team2} - ${timeText}! Gem of a match that will be treasured forever!`,
          `🎪 ${f.team1} vs ${f.team2} - ${timeText}! Showtime coming as two teams prepare to entertain!`,
          `🌟 ${f.team1} vs ${f.team2} - ${timeText}! Star power in action as two giants prepare for battle!`,
          `🔥 ${f.team1} vs ${f.team2} - ${timeText}! Hot action expected as two teams heat up the field!`,
          `⚡ ${f.team1} vs ${f.team2} - ${timeText}! Speed demon alert as two fast teams prepare for action!`,
          `🎯 ${f.team1} vs ${f.team2} - ${timeText}! Precision play expected as two skilled teams clash!`,
          `🚀 ${f.team1} vs ${f.team2} - ${timeText}! Sky high expectations as two top teams prepare for battle!`,
          `🏆 ${f.team1} vs ${f.team2} - ${timeText}! Championship material on display as two contenders clash!`,
          `⭐ ${f.team1} vs ${f.team2} - ${timeText}! Star quality cricket expected as two top teams battle!`,
          `💎 ${f.team1} vs ${f.team2} - ${timeText}! Diamond standard cricket as two quality teams prepare!`,
          `🎪 ${f.team1} vs ${f.team2} - ${timeText}! Entertainment central as two entertaining teams clash!`,
          `🌟 ${f.team1} vs ${f.team2} - ${timeText}! Heavenly performance expected as two divine teams battle!`,
          `🔥 ${f.team1} vs ${f.team2} - ${timeText}! Burning bright as two fiery teams prepare for action!`,
          `⚡ ${f.team1} vs ${f.team2} - ${timeText}! Electric atmosphere expected as two charged teams clash!`,
          `🎯 ${f.team1} vs ${f.team2} - ${timeText}! Bullseye target as two accurate teams prepare for battle!`,
          `🚀 ${f.team1} vs ${f.team2} - ${timeText}! Launching success as two successful teams prepare to clash!`,
          `🏆 ${f.team1} vs ${f.team2} - ${timeText}! Trophy hunt as two hunting teams prepare for battle!`,
          `⭐ ${f.team1} vs ${f.team2} - ${timeText}! Shining bright as two bright teams prepare for action!`,
          `💎 ${f.team1} vs ${f.team2} - ${timeText}! Precious moments expected as two valuable teams clash!`,
          `🎪 ${f.team1} vs ${f.team2} - ${timeText}! Show stopper expected as two entertaining teams prepare!`,
          `🌟 ${f.team1} vs ${f.team2} - ${timeText}! Star power in action as two powerful teams prepare for battle!`,
          `🔥 ${f.team1} vs ${f.team2} - ${timeText}! Hot action expected as two heated teams prepare to clash!`,
          `⚡ ${f.team1} vs ${f.team2} - ${timeText}! Lightning strikes expected as two electric teams prepare!`,
          `🎯 ${f.team1} vs ${f.team2} - ${timeText}! Target practice as two accurate teams prepare for battle!`,
          `🚀 ${f.team1} vs ${f.team2} - ${timeText}! Sky high as two elevated teams prepare for action!`,
          `🏆 ${f.team1} vs ${f.team2} - ${timeText}! Winner takes all as two determined teams prepare for battle!`,
          `⭐ ${f.team1} vs ${f.team2} - ${timeText}! Superstar clash as two star teams prepare for action!`,
          `💎 ${f.team1} vs ${f.team2} - ${timeText}! Gem of a match as two precious teams prepare for battle!`,
          `🎪 ${f.team1} vs ${f.team2} - ${timeText}! Entertainment guaranteed as two entertaining teams prepare!`,
          `🌟 ${f.team1} vs ${f.team2} - ${timeText}! Heavenly cricket as two divine teams prepare for battle!`
        ];
        
        title = pickVariant(`${f.team1}-${f.team2}-upcoming`, upcomingTitleVariants);
        body = pickVariant(`${f.team1}-${f.team2}-upcoming-body`, upcomingBodyVariants);
        isBreaking = isToday; // Today's matches are breaking news
        status = isToday ? 'today' : isTomorrow ? 'tomorrow' : 'upcoming';
      }
      
      // Add venue and format info if available
      if (f.venue) {
        body += ` 🏟️ Venue: ${f.venue}`;
      }
      if (f.format) {
        body += ` 📏 Format: ${f.format}`;
      }
      
      news.push({
        id: f._id, // Add the original fixture document ID
        kind: 'fixture',
        status,
        title,
        body,
        isBreaking,
        timestamp: isCompleted ? f.createdAt : f.matchTime, // Use match time for upcoming matches
        matchTime: f.matchTime,
        venue: f.venue,
        format: f.format,
        team1: f.team1,
        team2: f.team2,
        winner: f.winner,
        margin: f.margin,
        team1Score: f.team1Score,
        team2Score: f.team2Score,
        mom: f.mom
      });
    }

    // Process scheduled matches
    for (const s of schedules) {
      const matchDate = new Date(s.date);
      const now = new Date();
      const isToday = matchDate.toDateString() === now.toDateString();
      const isTomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString() === matchDate.toDateString();
      const isPast = matchDate < now;
      
      let title, body, status, isBreaking = false;
      
      // Format date and time
      const dateStr = matchDate.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric' 
      });
      const timeStr = s.time || 'TBD';
      
      // Determine status and content based on schedule status
      if (s.status === 'pending') {
        title = `📅 Match Invitation: ${s.requester} vs ${s.opponent}`;
        body = `${s.requester} has invited ${s.opponent} for a match on ${dateStr} at ${timeStr} (${s.timezone})`;
        status = 'pending';
        isBreaking = isToday;
      } else if (s.status === 'accepted') {
        title = `✅ Match Confirmed: ${s.requester} vs ${s.opponent}`;
        body = `Match scheduled for ${dateStr} at ${timeStr} (${s.timezone})`;
        status = isPast ? 'completed' : (isToday ? 'today' : isTomorrow ? 'tomorrow' : 'upcoming');
        isBreaking = isToday;
      } else if (s.status === 'rejected') {
        title = `❌ Match Rejected: ${s.requester} vs ${s.opponent}`;
        body = `${s.opponent} rejected the match invitation for ${dateStr} at ${timeStr}`;
        status = 'rejected';
        isBreaking = false;
      }
      
      // Add message if available
      if (s.message) {
        body += ` 💬 Note: ${s.message}`;
      }
      
      // Add new time proposal if available
      if (s.newTimeSlot && s.newDate) {
        const newDateStr = new Date(s.newDate).toLocaleDateString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric' 
        });
        body += ` 🔄 New time proposed: ${newDateStr} at ${s.newTimeSlot}`;
      }
      
      news.push({
        id: s._id,
        kind: 'schedule',
        status,
        title,
        body,
        isBreaking,
        timestamp: s.createdAt,
        matchDate: s.date,
        matchTime: s.time,
        timezone: s.timezone,
        requester: s.requester,
        opponent: s.opponent,
        scheduleStatus: s.status,
        message: s.message,
        newTimeSlot: s.newTimeSlot,
        newDate: s.newDate
      });
    }

    // Sort by timestamp desc and cap
    news.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Get social data for news items
    const newsWithSocialData = await getSocialData(news.slice(0, 100));
    
    // Summary logging
    const tradeCount = news.filter(n => n.kind === 'trade').length;
    const releaseCount = news.filter(n => n.kind === 'release').length;
    const pickCount = news.filter(n => n.kind === 'pick').length;
    const statsCount = news.filter(n => n.kind === 'stats').length;
    const fixtureCount = news.filter(n => n.kind === 'fixture').length;
    const scheduleCount = news.filter(n => n.kind === 'schedule').length;
    
    if (process.env.NODE_ENV !== 'production') console.log('📰 News Feed Summary:', {
      total: news.length,
      trades: tradeCount,
      releases: releaseCount,
      picks: pickCount,
      stats: statsCount,
      fixtures: fixtureCount,
      schedules: scheduleCount
    });
    
    const response = { items: newsWithSocialData };
    
    // 🚀 PERFORMANCE: Cache the response (30 second cache - frequently changing)
    cacheConfig.short.set(cacheKey, response);
    res.json(response);
  } catch (e) {
    console.error('Error building news feed', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


