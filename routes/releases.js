const express = require('express');
const router = express.Router();
const ReleaseRequest = require('../models/ReleaseRequest');
const UserPlayer = require('../models/UserPlayer');
const User = require('../models/User');
const Player = require('../models/Player'); // Add Player model import
const Bid = require('../models/Bid'); // Add Bid model import for cleanup
const { clampTradesUsed } = require('../utils/tradeConstants');
const { getTradeRules } = require('../utils/tradeRules');
const { isTradeLocked, TRADE_LOCK_HOURS } = require('../utils/tradeApprovalShared');
const { findOrphanPickToPairOnReleaseApprove } = require('../utils/releasePickPairing');
const { getTournamentIdFromRequest, withTournamentFilter } = require('../utils/tournamentScope');

const CRORE = 10000000;

const roundToTwo = (value = 0) => Number((value || 0).toFixed(2));

async function buildReleaseInsight(requestDoc) {
  try {
    const request = requestDoc.toObject ? requestDoc.toObject({ virtuals: true }) : requestDoc;
    const userId = request.user?._id || request.user;
    const playerId = request.player?._id || request.player;
    const tournamentId = request.tournamentId || null;
    if (!userId || !playerId) return null;

    const [activeCount, ownership, freshUser] = await Promise.all([
      UserPlayer.countDocuments(withTournamentFilter({ userId, isActive: true }, tournamentId)),
      // 🚀 PERFORMANCE: Use .lean() for read-only query
      UserPlayer.findOne(withTournamentFilter({ userId, playerId, isActive: true }, tournamentId)).select('bidValue').lean(),
      request.user && typeof request.user.purse !== 'undefined'
        ? null
        // 🚀 PERFORMANCE: Use .lean() for read-only query
        : User.findById(userId).select('purse').lean(),
    ]);

    const refundValue = Number(ownership?.bidValue || 0);
    const refundAvailable = refundValue > 0;
    const refundCrValue = refundAvailable ? refundValue / CRORE : null;
    const currentPurseRaw =
      request.user?.purse ?? freshUser?.purse ?? 0;
    const currentPurseCr = Number(currentPurseRaw) / CRORE;
    const projectedPurseCr = refundAvailable
      ? currentPurseCr + refundCrValue
      : currentPurseCr;
    const remainingPlayers = Math.max(
      activeCount - (ownership ? 1 : 0),
      0
    );

    const warnings = [];
    if (remainingPlayers < 16) {
      warnings.push(
        `Roster would drop to ${remainingPlayers} players after release.`
      );
    }
    if (!refundAvailable) {
      warnings.push('Refund value unavailable; admin will confirm amount.');
    }

    const baseSummary = `${request.user?.teamName || 'Team'} currently has ${activeCount} active players and ₹${roundToTwo(currentPurseCr)} Cr in purse.`;
    const summary = refundAvailable
      ? `${baseSummary} Releasing ${request.player?.name || 'this player'} would refund approximately ₹${roundToTwo(refundCrValue)} Cr, leaving ${remainingPlayers} players with a projected purse of ₹${roundToTwo(projectedPurseCr)} Cr.`
      : `${baseSummary} Releasing ${request.player?.name || 'this player'} keeps the purse at ₹${roundToTwo(projectedPurseCr)} Cr (refund amount pending confirmation).`;

    return {
      summary,
      refundCr: refundAvailable ? roundToTwo(refundCrValue) : null,
      projectedPurseCr: roundToTwo(projectedPurseCr),
      remainingPlayers,
      warnings,
    };
  } catch (error) {
    console.error('Release insight error:', error.message);
    return null;
  }
}

async function attachInsights(docs) {
  return Promise.all(
    docs.map(async doc => {
      const insight = await buildReleaseInsight(doc);
      // Handle both Mongoose documents and plain objects (from .lean())
      const obj = doc.toObject ? doc.toObject({ virtuals: true }) : { ...doc };
      if (insight) obj.aiInsight = insight;
      return obj;
    })
  );
}

// Create release request
router.post('/', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { userId, playerId } = req.body;
    if (!userId || !playerId) return res.status(400).json({ message: 'Missing required fields' });
    // Guard: user cannot exceed season trade cap (trade + release combined)
    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const u = await User.findById(userId).select('tradesUsed').lean();
    const rules = await getTradeRules();
    if (u && clampTradesUsed(u.tradesUsed) >= rules.tradeSeasonCap) {
      return res.status(400).json({ message: `You have used all ${rules.tradeSeasonCap} trades.` });
    }
    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const ownership = await UserPlayer.findOne(
      withTournamentFilter({ userId, playerId, isActive: true }, tournamentId)
    ).lean();
    if (!ownership) return res.status(400).json({ message: 'You do not own this player' });

    const playerForLock = await Player.findById(playerId).lean();
    if (!playerForLock) return res.status(400).json({ message: 'Player not found' });
    if (await isTradeLocked(playerForLock)) {
      return res.status(400).json({
        message: `This player cannot be released for ${TRADE_LOCK_HOURS} hours after a completed trade or unsold pick.`,
      });
    }

    // Prevent duplicate release requests while one is pending/admin_pending
    const existingPending = await ReleaseRequest.findOne(withTournamentFilter({
      user: userId,
      player: playerId,
      status: { $in: ['pending', 'admin_pending'] },
    }, tournamentId)).lean();
    if (existingPending) {
      return res.status(409).json({
        message: 'A release request for this player is already pending admin approval.',
      });
    }
    const rr = await ReleaseRequest.create({
      tournamentId: tournamentId || null,
      user: userId,
      player: playerId,
      status: 'pending',
      history: [{ byUser: userId, action: 'propose' }]
    });

    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const populated = await ReleaseRequest.findById(rr._id)
      .populate('player', 'name type role profilePicture')
      .populate('user', 'name teamName purse')
      .lean();

    // .lean() already returns a plain object, no need for .toObject()
    const responseObj = populated;
    responseObj.aiInsight = await buildReleaseInsight(populated);

    res.status(201).json(responseObj);
  } catch (e) {
    console.error('Release create error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// List my release requests
router.get('/user/:userId', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { userId } = req.params;
    const list = await ReleaseRequest.find(withTournamentFilter({ user: userId }, tournamentId))
      .populate('player', 'name type role profilePicture')
      .populate('user', 'name teamName purse')
      .sort({ createdAt: -1 });
    const enriched = await attachInsights(list);
    res.json(enriched);
  } catch (e) {
    console.error('Release list error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: pending
router.get('/admin/pending', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const list = await ReleaseRequest.find(
      withTournamentFilter({ status: { $in: ['pending', 'admin_pending'] } }, tournamentId)
    )
      .populate('user', 'name teamName purse')
      .populate('player', 'name type role profilePicture')
      .sort({ updatedAt: -1 })
      .lean();
    
    // Safely attach insights - if it fails, return list without insights
    let enriched = list;
    try {
      enriched = await attachInsights(list);
    } catch (insightError) {
      console.error('Error attaching insights to release requests:', insightError);
      // Continue without insights rather than failing the entire request
      enriched = list;
    }
    
    res.json(enriched || []);
  } catch (e) {
    console.error('Release pending error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin decide
router.post('/admin/:releaseId/decide', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { releaseId } = req.params;
    const { adminUserId, decision, note, confirmRelease } = req.body;
    const item = await ReleaseRequest.findOne(withTournamentFilter({ _id: releaseId }, tournamentId));
    if (!item) return res.status(404).json({ message: 'Release request not found' });
    
    if (decision === 'approve') {
      // VALIDATION: Only ensure user and player exist; releases are allowed with warning if below minimum.
      const user = await User.findById(item.user);
      const player = await Player.findById(item.player);
      
      if (!user || !player) {
        return res.status(404).json({ message: 'User or player not found' });
      }

      if (await isTradeLocked(player)) {
        return res.status(400).json({
          message: `Cannot approve release: player is trade-locked for ${TRADE_LOCK_HOURS} hours after a completed trade or unsold pick.`,
        });
      }

      // deactivate ownership
      const up = await UserPlayer.findOne(
        withTournamentFilter({ userId: item.user, playerId: item.player, isActive: true }, tournamentId)
      );
      if (up) { 
        up.isActive = false; 
        up.updatedAt = new Date(); 
        await up.save(); 
        
        // Refund the player's bid value back to the user's purse
        const bidValue = Number(up.bidValue || 0);
        if (bidValue > 0) {
          try {
            await User.findByIdAndUpdate(item.user, { 
              $inc: { purse: bidValue }
            });
          } catch {}
        }
        
        // CRITICAL FIX: Update the Player model to mark as unsold
        try {
          await Player.findByIdAndUpdate(item.player, {
            $set: {
              isSold: false,
              isActive: false,
              currentBid: null,
              currentBidder: null,
              tradeLocked: false,
              tradeLockedUntil: null,
              releasedAt: new Date() // Pick-from-unsold blocked for 48h after release
            }
          });
        } catch (playerUpdateError) {
          console.error('Error updating player status:', playerUpdateError);
        }
        
        // Remove player from user's boughtPlayers array
        try {
          await User.findByIdAndUpdate(item.user, {
            $pull: { boughtPlayers: item.player }
          });
        } catch (userUpdateError) {
          console.error('Error removing player from boughtPlayers:', userUpdateError);
        }
        
        // Clean up any remaining bid data for this player
        try {
          await Bid.deleteMany(withTournamentFilter({ playerId: item.player }, tournamentId));
        } catch (bidCleanupError) {
          console.error('Error cleaning up bid data:', bidCleanupError);
        }
      }
      
      item.status = 'completed';
      item.adminDecision = { status: 'approved', decidedBy: adminUserId, decidedAt: new Date(), note };
      if (player?.type && ['Sapphire', 'Gold', 'Emerald', 'Silver'].includes(player.type)) {
        item.releasedPlayerType = player.type;
      }

      // One slot for release + same-tier unsold pick together. If the pick was approved first, it already +1; link and skip release +1.
      let releaseSlotCharge = 1;
      if (player?.type && ['Sapphire', 'Gold', 'Emerald', 'Silver'].includes(player.type)) {
        const orphanPick = await findOrphanPickToPairOnReleaseApprove(item, player.type);
        if (orphanPick) {
          item.pairedPickRequest = orphanPick._id;
          releaseSlotCharge = 0;
        }
      }

      try {
        if (releaseSlotCharge) {
          await User.findByIdAndUpdate(item.user, { $inc: { tradesUsed: releaseSlotCharge } });
        }
      } catch {}
      
    } else if (decision === 'reject') {
      item.status = 'rejected';
      item.adminDecision = { status: 'rejected', decidedBy: adminUserId, decidedAt: new Date(), note };
      
      // Admin rejection does NOT affect trade count - no increment/decrement
      // The release request was pending, so it doesn't count towards tradesUsed
    } else {
      return res.status(400).json({ message: 'Invalid decision' });
    }
    
    await item.save();
    
    // Return populated release request
    const populatedItem = await ReleaseRequest.findById(releaseId)
      .populate('player', 'name type role profilePicture')
      .populate('user', 'name teamName purse');

    const responseObj = populatedItem.toObject({ virtuals: true });
    responseObj.aiInsight = await buildReleaseInsight(populatedItem);
    
    res.json(responseObj);
  } catch (e) {
    console.error('Release decide error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Withdraw release request
router.post('/:releaseId/withdraw', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { releaseId } = req.params;
    const { byUserId } = req.body;
    
    const item = await ReleaseRequest.findOne(withTournamentFilter({ _id: releaseId }, tournamentId));
    if (!item) {
      return res.status(404).json({ message: 'Release request not found' });
    }
    
    // Only the user who created the request can withdraw it
    if (String(item.user) !== String(byUserId)) {
      return res.status(403).json({ message: 'You can only withdraw your own release requests' });
    }
    
    // Only pending requests can be withdrawn
    if (!['pending', 'admin_pending'].includes(item.status)) {
      return res.status(400).json({ message: 'Only pending requests can be withdrawn' });
    }
    
    // Update status and add to history
    item.status = 'withdrawn';
    item.history.push({ 
      byUser: byUserId, 
      action: 'withdraw', 
      message: 'Request withdrawn by user',
      timestamp: new Date()
    });
    
    await item.save();
    
    // Return populated release request
    const populatedItem = await ReleaseRequest.findById(releaseId)
      .populate('player', 'name type role profilePicture')
      .populate('user', 'name teamName purse');
    
    const responseObj = populatedItem.toObject({ virtuals: true });
    responseObj.aiInsight = await buildReleaseInsight(populatedItem);

    res.json(responseObj);
  } catch (e) {
    console.error('Release withdraw error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: history (approved/rejected)
router.get('/admin/history', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const list = await ReleaseRequest.find(
      withTournamentFilter({ 'adminDecision.status': { $in: ['approved', 'rejected'] } }, tournamentId)
    )
      .populate('user', 'name teamName purse')
      .populate('player', 'name type role profilePicture')
      .populate('adminDecision.decidedBy', 'name email')
      .sort({ 'adminDecision.decidedAt': -1 });
    const enriched = await attachInsights(list);
    res.json(enriched);
  } catch (e) {
    console.error('Release history error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


