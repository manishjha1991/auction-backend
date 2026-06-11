const express = require('express');
const router = express.Router();
const PickRequest = require('../models/PickRequest');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const User = require('../models/User');
const Bid = require('../models/Bid');
const BidHistory = require('../models/BidHistory');
const mongoose = require('mongoose');
const axios = require('axios');
const Notification = require('../models/Notification');
const ReleaseRequest = require('../models/ReleaseRequest');
const { clampTradesUsed } = require('../utils/tradeConstants');
const { getTradeRules } = require('../utils/tradeRules');
const { findUnpairedReleaseForSameTierPick } = require('../utils/releasePickPairing');
const { setTradeLockOnPlayers } = require('../utils/tradeApprovalShared');

// Get unsold players list (isSold:false and isActive:false) with pagination, type filter, and search
router.get('/unsold', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));
    const type = req.query.type; // optional: Sapphire|Gold|Emerald|Silver
    const search = req.query.search; // optional: search by player name

    const filter = { isSold: false, isActive: false };
    // Exclude players released in last 48h (pick-from-unsold only; normal bidding unaffected)
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    filter.$or = [
      { releasedAt: null },
      { releasedAt: { $lt: fortyEightHoursAgo } }
    ];
    if (type) {
      filter.type = type;
    }
    
    // Add search functionality for player names
    if (search && search.trim()) {
      filter.name = { $regex: search.trim(), $options: 'i' }; // Case-insensitive search
    }

    const total = await Player.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const skip = (page - 1) * limit;

    // First, get all players that match the filter
    const allItems = await Player.find(filter)
      .select('name type role basePrice')
      .sort({ name: 1 })
      .lean();

    // Check which players have active bids (like in user section)
    const playerIds = allItems.map(item => item._id);
    const activeBids = await Bid.find({
      playerId: { $in: playerIds },
      isActive: true,
      isBidOn: true
    }).select('playerId');

    const playersWithActiveBids = new Set(activeBids.map(bid => bid.playerId.toString()));

    // Add bidding status indicator to items
    const itemsWithStatus = allItems.map(item => ({
      ...item,
      hasPendingRequest: playersWithActiveBids.has(item._id.toString()) // Player is under bidding if has active bids
    }));

    // Sort items to show "Request Raised" players first
    const sortedItems = itemsWithStatus.sort((a, b) => {
      // If both have or both don't have pending requests, sort by name
      if (a.hasPendingRequest === b.hasPendingRequest) {
        return a.name.localeCompare(b.name);
      }
      // If only one has pending request, prioritize it
      return b.hasPendingRequest - a.hasPendingRequest;
    });

    // Apply pagination to sorted items
    const items = sortedItems.slice(skip, skip + limit);

    res.json({ items, page, totalPages, total });
  } catch (e) {
    console.error('Unsold list error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Create pick request
router.post('/', async (req, res) => {
  try {
    const { userId, playerId } = req.body;
    if (!userId || !playerId) return res.status(400).json({ message: 'Missing required fields' });
    const [player, user] = await Promise.all([
      Player.findById(playerId),
      User.findById(userId)
    ]);
    if (!player || player.isSold) return res.status(400).json({ message: 'Player is not available' });
    // Block pick-from-unsold if player was released in last 48h (normal bidding unaffected)
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    if (player.releasedAt && new Date(player.releasedAt) > fortyEightHoursAgo) {
      return res.status(400).json({ message: 'This player was recently released and cannot be picked from unsold for 48 hours' });
    }
    if (!user) return res.status(404).json({ message: 'User not found' });

    const rules = await getTradeRules();
    try {
      const { assertCanRequestPick } = require('../utils/tradeSlotReservation');
      await assertCanRequestPick(userId, player.type, rules);
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }

    // Create an initial bid at base price and lock funds, so that existing sold API can finalize later
    const basePrice = Number(player.basePrice || 0);
    const purse = Number(user.purse ? parseFloat(user.purse.toString()) : 0);
    if (purse < basePrice) return res.status(400).json({ message: 'Insufficient purse for base price' });

    // Deduct basePrice as locked amount and add to currentBids
    const updatedPurse = purse - basePrice;
    user.purse = mongoose.Types.Decimal128.fromString(updatedPurse.toString());
    user.currentBids = user.currentBids || [];
    const existingCB = user.currentBids.find(cb => cb.playerId && cb.playerId.toString() === String(player._id));
    if (existingCB) {
      existingCB.amount = basePrice;
    } else {
      user.currentBids.push({ playerId: player._id, amount: basePrice });
    }
    await user.save();

    // Create a live bid
    const newBid = new Bid({ playerId: player._id, bidder: user._id, bidAmount: basePrice, isActive: true, isBidOn: true });
    await newBid.save();

    // Reflect current bid on player
    player.currentBid = basePrice;
    player.currentBidder = user._id;
    await player.save();

    const pr = await PickRequest.create({ user: userId, player: playerId, status: 'pending', history: [{ byUser: userId, action: 'propose' }] });
    res.status(201).json(pr);
  } catch (e) {
    console.error('Pick create error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// User: my pick requests
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const picks = await PickRequest.find({ user: userId }).populate('player', 'name type role').sort({ createdAt: -1 });
    res.json(picks);
  } catch (e) {
    console.error('Pick list error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: pending picks
router.get('/admin/pending', async (req, res) => {
  try {
    const picks = await PickRequest.find({ status: { $in: ['pending', 'admin_pending'] } })
      .populate('user', 'name teamName')
      .populate('player', 'name type role basePrice')
      .sort({ updatedAt: -1 });
    res.json(picks);
  } catch (e) {
    console.error('Pick pending error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: decide pick
router.post('/admin/:pickId/decide', async (req, res) => {
  try {
    const { pickId } = req.params;
    const { adminUserId, decision, note } = req.body;
    const item = await PickRequest.findById(pickId);
    if (!item) return res.status(404).json({ message: 'Pick request not found' });

    if (decision === 'approve') {
      // VALIDATION: Check type limits before approving
      const user = await User.findById(item.user).populate('boughtPlayers');
      const player = await Player.findById(item.player);
      
      if (!user || !player) {
        return res.status(404).json({ message: 'User or player not found' });
      }
      
      // Check type limits
      const typeLimit = {
        Sapphire: 2,
        Gold: 8,
        Emerald: 4,
        Silver: 6,
      };
      
      // Count bought players of this type (including retained)
      const boughtPlayersOfThisType = await Player.countDocuments({
        _id: { $in: user.boughtPlayers },
        type: player.type,
      });
      
      // Check if approving would exceed limit
      if (boughtPlayersOfThisType >= typeLimit[player.type]) {
        return res.status(400).json({ 
          message: `Cannot approve: User already has ${boughtPlayersOfThisType} ${player.type} player(s). Maximum allowed is ${typeLimit[player.type]}.` 
        });
      }

      // Same-tier release + same-tier unsold pick = one tradesUsed total (paired on ReleaseRequest).
      // Any other unsold pick (e.g. after a cross-tier trade to refill a short category) adds +1 tradesUsed — same as a separate roster move.
      const userLean = await User.findById(item.user).select('tradesUsed').lean();
      const rules = await getTradeRules();
      const releasePairDoc = await findUnpairedReleaseForSameTierPick(
        item.user,
        player.type,
        item.createdAt
      );

      const usePair = !!releasePairDoc;
      const useStandaloneCharge = !usePair;

      if (
        useStandaloneCharge &&
        clampTradesUsed(userLean?.tradesUsed) >= rules.tradeSeasonCap
      ) {
        return res.status(400).json({
          message: `Cannot approve pick: season trade cap reached (${rules.tradeSeasonCap}).`,
        });
      }

      const base = process.env.SELF_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const soldResp = await axios.post(`${base}/api/bids/bid/sold`, { playerID: item.player });
      if (soldResp.status >= 400) {
        return res.status(400).json({ message: 'Failed to finalize sale via sold API' });
      }

      if (usePair && releasePairDoc) {
        await ReleaseRequest.findByIdAndUpdate(releasePairDoc._id, {
          $set: { pairedPickRequest: item._id },
        });
      } else if (useStandaloneCharge) {
        await User.findByIdAndUpdate(item.user, { $inc: { tradesUsed: 1 } });
      }

      await Player.findByIdAndUpdate(item.player, { isActive: true });
      await setTradeLockOnPlayers([item.player]);

      item.status = 'completed';
      item.adminDecision = { status: 'approved', decidedBy: adminUserId, decidedAt: new Date(), note };
    } else if (decision === 'reject') {
      // Free the locked money back to user's purse when rejecting pick
      const user = await User.findById(item.user);
      if (user) {
        // Find the locked amount for this player
        const userBid = user.currentBids.find(bid => bid.playerId.toString() === item.player.toString());
        if (userBid) {
          const lockedAmount = userBid.amount;
          const purse = parseFloat(user.purse.toString());
          user.purse = mongoose.Types.Decimal128.fromString((purse + lockedAmount).toString());
          
          // Remove the bid from user's current bids
          user.currentBids = user.currentBids.filter(bid => bid.playerId.toString() !== item.player.toString());
          await user.save();
        }
      }
      
      // Mark the bid as inactive
      await Bid.updateMany(
        { playerId: item.player, bidder: item.user }, 
        { $set: { isActive: false, isBidOn: false } }
      );
      
      // Reset player's current bid if this was the only bid
      const player = await Player.findById(item.player);
      if (player && player.currentBidder && player.currentBidder.toString() === item.user.toString()) {
        player.currentBid = null;
        player.currentBidder = null;
        // Ensure player is available for future picks by setting isActive to false
        player.isActive = false;
        await player.save();
      }
      
      item.status = 'rejected';
      item.adminDecision = { status: 'rejected', decidedBy: adminUserId, decidedAt: new Date(), note };
      
      // Emit rejection notification for admin branch
      try {
        const io = req.app.get('io');
        const notificationData = {
          message: `Pick rejected: ${user?.name || 'User'} had their pick request for ${player?.name || 'Player'} rejected by admin. Locked amount refunded.`,
          playername: player?.name,
          currentBid: player?.currentBid,
          currentBidder: player?.currentBidder,
          rejectedUser: user?.name
        };
        // Save notification in DB
        const newNotification = new Notification(notificationData);
        await newNotification.save();
        io.emit('pick_rejection_notification', newNotification);
      } catch (notificationError) {
        console.error('Notification error:', notificationError);
      }
    } else {
      return res.status(400).json({ message: 'Invalid decision' });
    }
    await item.save();
    res.json(item);
  } catch (e) {
    console.error('Pick decide error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: pick history
router.get('/admin/history', async (req, res) => {
  try {
    const picks = await PickRequest.find({ 'adminDecision.status': { $in: ['approved', 'rejected'] } })
      .populate('user', 'name teamName')
      .populate('player', 'name type role basePrice')
      .populate('adminDecision.decidedBy', 'name email')
      .sort({ 'adminDecision.decidedAt': -1 });
    res.json(picks);
  } catch (e) {
    console.error('Pick history error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


