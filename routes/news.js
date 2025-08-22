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

router.get('/feed', async (_req, res) => {
  try {
    const [trades, releases, picks, recentStats, fixtures] = await Promise.all([
      TradeRequest.find({})
        .populate('fromUser', 'name teamName isTournamentReady')
        .populate('toUser', 'name teamName isTournamentReady')
        .populate('offeredPlayer', 'name type role')
        .populate('requestedPlayer', 'name type role')
        .sort({ updatedAt: -1 })
        .limit(50), // Increased limit to show more trades
      ReleaseRequest.find({})
        .populate({
          path: 'user',
          select: 'teamName isTournamentReady',
          model: 'User'
        })
        .populate({
          path: 'player',
          select: 'name type',
          model: 'Player'
        })
        .sort({ updatedAt: -1 })
        .limit(30),
      PickRequest.find({})
        .populate('user', 'teamName isTournamentReady')
        .populate('player', 'name type basePrice')
        .sort({ updatedAt: -1 })
        .limit(30),
      PlayerStats.find({}).sort({ createdAt: -1 }).limit(50).lean(),
      Fixture.find({ isActive: true, winner: { $ne: null } }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    // Test query to see raw data
    try {
      const rawReleases = await ReleaseRequest.find({ status: 'withdrawn' }).limit(5);
      console.log('🔍 Raw withdrawn releases (no population):', rawReleases.map(r => ({
        id: r._id,
        status: r.status,
        userId: r.user,
        playerId: r.player,
        updatedAt: r.updatedAt
      })));
    } catch (error) {
      console.error('❌ Raw query failed:', error);
    }

    // Debug logging
    console.log('🔍 News Feed - Trades found:', trades.length);
    console.log('🔍 News Feed - Releases found:', releases.length);
    console.log('🔍 News Feed - Picks found:', picks.length);
    console.log('🔍 News Feed - Sample trade:', trades[0]);
    console.log('🔍 News Feed - Sample release:', releases[0]);
    console.log('🔍 News Feed - Sample pick:', picks[0]);

    const news = [];

    // Trades
    for (const t of trades) {
      // Debug individual trade
      console.log('🔍 Processing trade:', {
        id: t._id,
        status: t.status,
        fromUser: t.fromUser,
        toUser: t.toUser,
        offeredPlayer: t.offeredPlayer,
        requestedPlayer: t.requestedPlayer
      });

      // Skip trades involving users who aren't tournament ready
      if (!t.fromUser?.isTournamentReady || !t.toUser?.isTournamentReady) {
        console.log('⚠️ Skipping trade - users not tournament ready:', {
          fromUser: t.fromUser?.teamName,
          toUser: t.toUser?.teamName,
          fromUserReady: t.fromUser?.isTournamentReady,
          toUserReady: t.toUser?.isTournamentReady
        });
        continue;
      }

      const offeredName = t.offeredPlayer?.name || 'Unknown Player';
      const requestedName = t.requestedPlayer?.name || 'Unknown Player';
      const fromTeam = t.fromUser?.teamName || 'Unknown Team';
      const toTeam = t.toUser?.teamName || 'Unknown Team';
      
      console.log('🔍 Extracted names:', { offeredName, requestedName, fromTeam, toTeam });
      
      // Try to infer trade value from user-player bid values
      let approxValue = 0;
      try {
        const [up1, up2] = await Promise.all([
          UserPlayer.findOne({ playerId: t.offeredPlayer?._id, isActive: true }).lean(),
          UserPlayer.findOne({ playerId: t.requestedPlayer?._id, isActive: true }).lean(),
        ]);
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
      // Debug individual release with full object
      console.log('🔍 Processing release - FULL OBJECT:', JSON.stringify(r, null, 2));
      console.log('🔍 Processing release - ID:', r._id);
      console.log('🔍 Processing release - Status:', r.status);
      console.log('🔍 Processing release - User object:', r.user);
      console.log('🔍 Processing release - Player object:', r.player);
      console.log('🔍 Processing release - User ID:', r.user?._id);
      console.log('🔍 Processing release - Player ID:', r.player?._id);

      // Skip releases from users who aren't tournament ready
      if (!r.user?.isTournamentReady) {
        console.log('⚠️ Skipping release - user not tournament ready:', {
          user: r.user?.teamName,
          userReady: r.user?.isTournamentReady
        });
        continue;
      }

      let title = '';
      let body = '';
      
      // Check if population worked and try manual fallback if needed
      let userData = r.user;
      let playerData = r.player;
      
      if (!userData || !playerData) {
        console.log('⚠️ Population failed for release:', r._id);
        console.log('⚠️ User populated:', !!userData);
        console.log('⚠️ Player populated:', !!playerData);
        
        // Try manual fallback - fetch data directly
        try {
          if (!userData && r.user) {
            const user = await User.findById(r.user).select('teamName').lean();
            userData = user;
            console.log('🔄 Manual user fetch result:', userData);
          }
          
          if (!playerData && r.player) {
            const player = await Player.findById(r.player).select('name type').lean();
            playerData = player;
            console.log('🔄 Manual player fetch result:', playerData);
          }
        } catch (error) {
          console.error('❌ Manual fetch failed:', error);
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
      
      console.log('🔍 Release title/body:', { title, body });
      
      // Only add to news if we have a valid title and body
      if (title && body) {
        news.push({ 
          kind: 'release', 
          status: r.status, 
          title, 
          body, 
          isBreaking: false, 
          timestamp: r.updatedAt 
        });
      } else {
        console.log('❌ Skipping release due to empty title/body:', { id: r._id, status: r.status, title, body });
      }
    }

    // Picks
    for (const p of picks) {
      // Debug individual pick
      console.log('🔍 Processing pick:', {
        id: p._id,
        status: p.status,
        user: p.user,
        player: p.player
      });

      // Skip picks from users who aren't tournament ready
      if (!p.user?.isTournamentReady) {
        console.log('⚠️ Skipping pick - user not tournament ready:', {
          user: p.user?.teamName,
          userReady: p.user?.isTournamentReady
        });
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
      
      console.log('🔍 Pick title/body:', { title, body });
      
      news.push({ 
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
      const runs = s.battingStats?.runs || 0;
      const wickets = s.bowlingStats?.wickets || 0;
      const ballsBowled = s.bowlingStats?.ballsBowled || 0;
      const [player, user, opp] = await Promise.all([
        Player.findById(s.playerId).select('name type').lean(),
        User.findById(s.userId).select('teamName isTournamentReady').lean(),
        s.opponentUserId ? User.findById(s.opponentUserId).select('teamName isTournamentReady').lean() : Promise.resolve(null),
      ]);

      // Skip stats from users who aren't tournament ready
      if (!user?.isTournamentReady || (opp && !opp.isTournamentReady)) {
        console.log('⚠️ Skipping stats - users not tournament ready:', {
          user: user?.teamName,
          opponent: opp?.teamName,
          userReady: user?.isTournamentReady,
          opponentReady: opp?.isTournamentReady
        });
        continue;
      }

      // All-round performance
      if (runs >= 20 && wickets >= 3) {
        const allRoundPhrases = [
          `🔥 ${player?.name} delivers a masterclass! ${runs}+ runs AND ${wickets} wickets for ${user?.teamName}!`,
          `⚡ ${player?.name} is the complete package! ${runs} runs + ${wickets} wickets = pure dominance!`,
          `🎯 ${player?.name} shows why they're the MVP! ${runs} runs and ${wickets} wickets for ${user?.teamName}!`,
          `🚀 ${player?.name} - the ultimate all-rounder! ${runs} runs + ${wickets} wickets = game changer!`,
        ];
        news.push({
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
          `