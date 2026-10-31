const express = require('express');
const router = express.Router();
const PickRequest = require('../models/PickRequest');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const User = require('../models/User');
const Bid = require('../models/Bid');
const BidHistory = require('../models/BidHistory');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const ReleaseRequest = require('../models/ReleaseRequest');
const { clampTradesUsed } = require('../utils/tradeConstants');
const { getTradeRules } = require('../utils/tradeRules');
const { findUnpairedReleaseForSameTierPick } = require('../utils/releasePickPairing');
const { setTradeLockOnPlayers } = require('../utils/tradeApprovalShared');
const { getRosterCaps, typeLimitMap } = require('../utils/rosterCaps');
const { assertIndiaCap, normalizeObjectIds, sanitizeUserPlayerRefs, extractObjectId } = require('../utils/indiaCap');
const { sellPlayer } = require('./bidRoutes');

// Get unsold players list (isSold: false only)
router.get('/unsold', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const type = req.query.type; // optional: Sapphire|Gold|Emerald|Silver
    const search = req.query.search; // optional: search by player name
    const role = (req.query.role || '').trim();
    const country = (req.query.country || '').trim();
    const bowlingStyle = (req.query.bowlingStyle || '').trim();

    const filter = { isSold: { $ne: true } };
    if (type) {
      filter.type = type;
    }
    
    // Add search functionality for player names
    if (search && search.trim()) {
      filter.name = { $regex: search.trim(), $options: 'i' }; // Case-insensitive search
    }
    if (role) {
      filter.role = { $regex: new RegExp(`^${role}$`, 'i') };
    }
    if (country) {
      filter.country = { $regex: new RegExp(`^${country}$`, 'i') };
    }
    if (bowlingStyle) {
      const escapedStyle = bowlingStyle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.bowlingStyle = { $regex: new RegExp(`^${escapedStyle}$`, 'i') };
    }

    const total = await Player.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const skip = (page - 1) * limit;

    const [allItems, countryValues, liveBidCount] = await Promise.all([
      Player.find(filter)
        .select('name type role basePrice isActive country overallScore bowlingStyle style')
        .lean(),
      Player.distinct('country', { isSold: { $ne: true } }),
      Bid.countDocuments({ isActive: true, isBidOn: true }),
    ]);

    const playerIds = allItems.map((item) => item._id);
    const activeBids = await Bid.find({
      playerId: { $in: playerIds },
      isActive: true,
      isBidOn: true,
    }).select('playerId bidAmount');

    const playersWithActiveBids = new Set();
    const bidAmountByPlayer = new Map();
    activeBids.forEach((bid) => {
      const id = bid.playerId.toString();
      playersWithActiveBids.add(id);
      const amount = Number(bid.bidAmount) || 0;
      bidAmountByPlayer.set(id, Math.max(bidAmountByPlayer.get(id) || 0, amount));
    });

    const auctionRunning = liveBidCount > 0 || allItems.some((p) => p.isActive === true);

    const itemsWithStatus = allItems.map((item) => {
      const id = item._id.toString();
      return {
        ...item,
        hasPendingRequest: playersWithActiveBids.has(id),
        currentBidAmount: bidAmountByPlayer.get(id) || 0,
      };
    });

    const sortedItems = itemsWithStatus.sort((a, b) => {
      if (auctionRunning) {
        const bidDiff = (Number(b.currentBidAmount) || 0) - (Number(a.currentBidAmount) || 0);
        if (bidDiff !== 0) return bidDiff;
      }
      const scoreDiff = (Number(b.overallScore) || 0) - (Number(a.overallScore) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    // Apply pagination to sorted items
    const items = sortedItems.slice(skip, skip + limit);

    const countries = (countryValues || [])
      .map((c) => String(c || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    res.json({
      items,
      page,
      totalPages,
      total,
      auctionRunning,
      sortBy: auctionRunning ? 'bid' : 'overall',
      countries,
      roles: ['Batsman', 'Bowler', 'Allrounder', 'WicketKeeper'],
      bowlingStyles: ['RF', 'LF', 'RFM', 'LFM', 'OS', 'SLU', 'LS'],
    });
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

    const indiaCheck = await assertIndiaCap({
      user,
      player,
      caps: await getRosterCaps(),
      alreadyEngaged: false,
      includeQueue: true,
    });
    if (!indiaCheck.ok) {
      return res.status(indiaCheck.status || 400).json({ message: indiaCheck.message });
    }

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
    const existingCB = user.currentBids.find(
      (cb) => extractObjectId(cb?.playerId) === String(player._id)
    );
    if (existingCB) {
      existingCB.amount = basePrice;
    } else {
      user.currentBids.push({ playerId: player._id, amount: basePrice });
    }
    sanitizeUserPlayerRefs(user);
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
      const user = await User.findById(item.user);
      const player = await Player.findById(item.player);
      
      if (!user || !player) {
        return res.status(404).json({ message: 'User or player not found' });
      }
      
      const caps = await getRosterCaps();
      const typeLimit = typeLimitMap(caps);
      const boughtIds = normalizeObjectIds(user.boughtPlayers);
      
      // Count bought players of this type (including retained)
      const boughtPlayersOfThisType = boughtIds.length
        ? await Player.countDocuments({
            _id: { $in: boughtIds },
            type: player.type,
          })
        : 0;
      
      // Check if approving would exceed limit
      if (boughtPlayersOfThisType >= typeLimit[player.type]) {
        return res.status(400).json({ 
          message: `Cannot approve: User already has ${boughtPlayersOfThisType} ${player.type} player(s). Maximum allowed is ${typeLimit[player.type]}.` 
        });
      }

      if (player.type === 'Emerald' || player.type === 'Sapphire') {
        const combinedESCount = boughtIds.length
          ? await Player.countDocuments({
              _id: { $in: boughtIds },
              type: { $in: ['Emerald', 'Sapphire'] },
            })
          : 0;
        if (combinedESCount >= caps.sapphireEmeraldMax) {
          return res.status(400).json({
            message: `Cannot approve: User already has ${combinedESCount} Emerald + Sapphire player(s). Combined maximum is ${caps.sapphireEmeraldMax}.`,
          });
        }
      }

      const indiaCheck = await assertIndiaCap({
        user,
        player,
        caps,
        alreadyEngaged: false,
        includeQueue: false,
      });
      if (!indiaCheck.ok) {
        return res.status(indiaCheck.status || 400).json({ message: indiaCheck.message });
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

      const soldResult = await sellPlayer(item.player, req.app.get('io'));
      if (!soldResult || soldResult.status !== 'success') {
        return res.status(400).json({
          message: soldResult?.message || 'Failed to finalize sale via sold API',
        });
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
        const pickPlayerId = extractObjectId(item.player);
        const userBid = (user.currentBids || []).find(
          (bid) => extractObjectId(bid?.playerId) === pickPlayerId
        );
        if (userBid) {
          const lockedAmount = userBid.amount;
          const purse = parseFloat(user.purse.toString());
          user.purse = mongoose.Types.Decimal128.fromString((purse + lockedAmount).toString());
          
          // Remove the bid from user's current bids
          user.currentBids = user.currentBids.filter(
            (bid) => extractObjectId(bid?.playerId) !== pickPlayerId
          );
          sanitizeUserPlayerRefs(user);
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


