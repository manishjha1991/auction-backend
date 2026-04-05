const express = require('express');
const router = express.Router();
const TradeRequest = require('../models/TradeRequest');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
const {
  analyzeTeamBalance,
  generateTradeRecommendations,
} = require('../utils/tradeInsights');
const {
  isTradeLocked,
  setTradeLockOnPlayers,
  autoRejectTradesInvolvingPlayers,
} = require('../utils/tradeApprovalShared');
const {
  TRADE_SEASON_CAP,
  MAX_ACTIVE_OUTGOING_TRADES,
  clampTradesUsed,
} = require('../utils/tradeConstants');
// Limits similar to bidding constraints
const TYPE_LIMITS = { Sapphire: 2, Gold: 8, Emerald: 4, Silver: 6 };
const COMBINED_ES_LIMIT = 5; // Emerald + Sapphire combined

async function getUserTypeCounts(userId) {
  // 🚀 PERFORMANCE: Use .lean() for read-only query
  const ups = await UserPlayer.find({ userId, isActive: true }).populate('playerId', 'type').lean();
  const counts = { Sapphire: 0, Gold: 0, Emerald: 0, Silver: 0 };
  for (const up of ups) {
    const t = up.playerId?.type;
    if (counts.hasOwnProperty(t)) counts[t] += 1;
  }
  return counts;
}

function wouldExceedTypeLimits(counts) {
  for (const [k, v] of Object.entries(TYPE_LIMITS)) {
    if ((counts[k] || 0) > v) return true;
  }
  const es = (counts['Emerald'] || 0) + (counts['Sapphire'] || 0);
  if (es > COMBINED_ES_LIMIT) return true;
  return false;
}

// Helper: ensure player ownership
async function getOwnerOfPlayer(playerId) {
  // 🚀 PERFORMANCE: Use .lean() for read-only query
  const up = await UserPlayer.findOne({ playerId, isActive: true }).populate('userId').lean();
  return up ? up.userId : null;
}

router.get('/insights/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const balance = await analyzeTeamBalance(userId);
    const recommendations = await generateTradeRecommendations(userId, { limit: 3 });

    res.json({ balance, recommendations });
  } catch (error) {
    console.error('Trade insights error:', error);
    res
      .status(error.statusCode || 500)
      .json({ message: error.message || 'Unable to generate trade insights' });
  }
});

// POST create trade request
router.post('/', async (req, res) => {
  try {
    const { fromUserId, offeredPlayerId, requestedPlayerId } = req.body;
    if (!fromUserId || !offeredPlayerId || !requestedPlayerId) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    // Enforce max active outgoing trade requests per user (MAX_ACTIVE_OUTGOING_TRADES)
    const activeCount = await TradeRequest.countDocuments({
      fromUser: fromUserId,
      status: { $in: ['pending', 'counter', 'admin_pending'] }
    });
    if (activeCount >= MAX_ACTIVE_OUTGOING_TRADES) {
      return res.status(400).json({
        message: `Trade limit reached: You can have at most ${MAX_ACTIVE_OUTGOING_TRADES} active trade requests.`,
      });
    }

    // Enforce total trade usage cap (completed trades + approved releases → tradesUsed)
    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const proposer = await User.findById(fromUserId).select('tradesUsed').lean();
    if (proposer && clampTradesUsed(proposer.tradesUsed) >= TRADE_SEASON_CAP) {
      return res.status(400).json({ message: `You have used all ${TRADE_SEASON_CAP} trades.` });
    }

    // Prevent duplicate/parallel trade requests for the same players while active
    const activeTrade = await TradeRequest.findOne({
      status: { $in: ['pending', 'counter', 'admin_pending'] },
      $or: [
        { offeredPlayer: offeredPlayerId },
        { requestedPlayer: requestedPlayerId },
        { offeredPlayer: requestedPlayerId },
        { requestedPlayer: offeredPlayerId }
      ]
    }).lean();
    if (activeTrade) {
      return res.status(409).json({
        message: 'One or both players already have an active trade request. Please wait for admin decision or withdraw the existing request.'
      });
    }

    const [fromUser, offeredOwner, requestedOwner] = await Promise.all([
      User.findById(fromUserId), // Not using .lean() - might be modified later
      getOwnerOfPlayer(offeredPlayerId),
      getOwnerOfPlayer(requestedPlayerId)
    ]);

    if (!fromUser || !offeredOwner || !requestedOwner) {
      return res.status(404).json({ message: 'User or players not found.' });
    }

    // BASIC VALIDATION ONLY (for proposal creation)
    // Heavy validation (type limits, purse, etc.) happens at admin approval
    if (String(offeredOwner._id) !== String(fromUser._id)) {
      return res.status(403).json({ message: 'You do not own the offered player.' });
    }

    if (String(requestedOwner._id) === String(fromUser._id)) {
      return res.status(400).json({ message: 'Requested player is already in your team.' });
    }

    const [offeredPlayer, requestedPlayer, offeredUP, requestedUP] = await Promise.all([
      // 🚀 PERFORMANCE: Use .lean() for read-only queries
      Player.findById(offeredPlayerId).lean(),
      Player.findById(requestedPlayerId).lean(),
      UserPlayer.findOne({ playerId: offeredPlayerId, isActive: true }).populate('userId').lean(),
      UserPlayer.findOne({ playerId: requestedPlayerId, isActive: true }).populate('userId').lean()
    ]);

    if (!offeredUP || !requestedUP) {
      return res.status(400).json({ message: 'One or both players are not available for trade.' });
    }

    if ((await isTradeLocked(offeredPlayer)) || (await isTradeLocked(requestedPlayer))) {
      return res.status(409).json({
        message: 'One or both players are already trade-locked and cannot be traded again.'
      });
    }

    // REMOVED: Heavy validation (type limits, purse validation) - moved to admin approval
    // Only basic validation remains for proposal creation
    // This allows users to propose trades that might be invalid, but admin will catch them

    const trade = await TradeRequest.create({
      fromUser: fromUser._id,
      toUser: requestedOwner._id,
      offeredPlayer: offeredPlayer._id,
      requestedPlayer: requestedPlayer._id,
      status: 'pending',
      history: [
        { byUser: fromUser._id, action: 'propose', message: 'Initial proposal', offeredPlayer: offeredPlayer._id, requestedPlayer: requestedPlayer._id }
      ]
    });

    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const populated = await TradeRequest.findById(trade._id)
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role')
      .populate('requestedPlayer', 'name type role')
      .lean();

    res.status(201).json(populated);
  } catch (err) {
    console.error('Create trade error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST respond to trade (accept/reject)
router.post('/:tradeId/respond', async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { byUserId, decision, message } = req.body; // decision: accept|reject
    const trade = await TradeRequest.findById(tradeId);
    if (!trade) return res.status(404).json({ message: 'Trade not found' });
    // Allow recipient to respond to initial proposals, and proposer to respond to counters
    const isRecipientResponding = String(trade.toUser) === String(byUserId) && trade.status === 'pending';
    const isProposerRespondingToCounter = String(trade.fromUser) === String(byUserId) && trade.status === 'counter';
    if (!isRecipientResponding && !isProposerRespondingToCounter) {
      return res.status(403).json({ message: 'Not authorized to respond at this stage.' });
    }

    if (decision === 'accept') {
      trade.status = 'admin_pending';
      trade.history.push({ byUser: byUserId, action: 'accept', message });
    } else if (decision === 'reject') {
      trade.status = 'rejected';
      trade.history.push({ byUser: byUserId, action: 'reject', message });
    } else {
      return res.status(400).json({ message: 'Invalid decision' });
    }

    await trade.save();
    const populated = await TradeRequest.findById(trade._id)
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role')
      .populate('requestedPlayer', 'name type role');
    res.json(populated);
  } catch (err) {
    console.error('Respond trade error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST negotiate (counter) with a counter offered player
// Countering is disabled
router.post('/:tradeId/negotiate', async (_req, res) => {
  return res.status(400).json({ message: 'Counter offers are disabled.' });
});

// POST withdraw own trade proposal (only proposer can withdraw if not completed/rejected)
router.post('/:tradeId/withdraw', async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { byUserId } = req.body;
    const trade = await TradeRequest.findById(tradeId);
    if (!trade) return res.status(404).json({ message: 'Trade not found' });
    if (String(trade.fromUser) !== String(byUserId)) {
      return res.status(403).json({ message: 'Only the proposer can withdraw this trade.' });
    }
    if (['completed', 'rejected', 'withdrawn'].includes(trade.status)) {
      return res.status(400).json({ message: 'Trade cannot be withdrawn.' });
    }
    trade.status = 'withdrawn';
    trade.history.push({ byUser: byUserId, action: 'withdraw', message: 'Proposal withdrawn by proposer' });
    await trade.save();
    const populated = await TradeRequest.findById(trade._id)
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role')
      .populate('requestedPlayer', 'name type role');
    res.json(populated);
  } catch (err) {
    console.error('Withdraw trade error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET trades for a user (inbox + outbox)
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const trades = await TradeRequest.find({ $or: [{ fromUser: userId }, { toUser: userId }] })
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role')
      .populate('requestedPlayer', 'name type role')
      .populate('history.byUser', 'name teamName')
      .populate('history.offeredPlayer', 'name type role')
      .populate('history.requestedPlayer', 'name type role')
      .sort({ createdAt: -1 });
    res.json(trades);
  } catch (err) {
    console.error('List trades error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET trades pending admin approval
router.get('/admin/pending', async (req, res) => {
  try {
    const trades = await TradeRequest.find({ status: 'admin_pending' })
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role')
      .populate('requestedPlayer', 'name type role')
      .sort({ updatedAt: -1 });
    res.json(trades);
  } catch (err) {
    console.error('Admin pending list error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET trades history for admin (completed, rejected, withdrawn)
router.get('/admin/history', async (req, res) => {
  try {
    const trades = await TradeRequest.find({ 'adminDecision.status': { $in: ['approved', 'rejected'] } })
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role')
      .populate('requestedPlayer', 'name type role')
      .populate('adminDecision.decidedBy', 'name email')
      .sort({ 'adminDecision.decidedAt': -1 });
    res.json(trades);
  } catch (err) {
    console.error('Admin history list error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST admin decision
router.post('/admin/:tradeId/decide', async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { adminUserId, decision, note } = req.body; // decision: approve|reject
    const trade = await TradeRequest.findById(tradeId);
    if (!trade) return res.status(404).json({ message: 'Trade not found' });

    if (decision === 'approve') {
      // COMPREHENSIVE VALIDATION: Check all trade violations before approval
      const [offeredUP, requestedUP] = await Promise.all([
        UserPlayer.findOne({ playerId: trade.offeredPlayer, isActive: true }).populate('userId'),
        UserPlayer.findOne({ playerId: trade.requestedPlayer, isActive: true }).populate('userId')
      ]);
      if (!offeredUP || !requestedUP) {
        return res.status(400).json({ message: 'Players not available for trade' });
      }
      
      const team1 = offeredUP.userId;
      const team2 = requestedUP.userId;

      // 1. PURSE VALIDATION: Ensure both teams would not go negative after swap
      const offeredValue = Number(offeredUP.bidValue || 0);
      const requestedValue = Number(requestedUP.bidValue || 0);
      const team1Purse = Number(team1.purse || 0);
      const team2Purse = Number(team2.purse || 0);
      
      const newTeam1Purse = team1Purse + offeredValue - requestedValue;
      const newTeam2Purse = team2Purse + requestedValue - offeredValue;
      
      if (Number.isNaN(newTeam1Purse) || Number.isNaN(newTeam2Purse)) {
        return res.status(400).json({ message: 'Invalid purse or bid values for trade validation.' });
      }
      if (newTeam1Purse < 0 || newTeam2Purse < 0) {
        const toCr = (n) => (Number(n) / 10000000).toFixed(2);
        const parts = [];
        if (newTeam1Purse < 0) {
          const shortfall = Math.abs(newTeam1Purse);
          parts.push(`${team1.teamName || 'Team 1'}: current ₹${toCr(team1Purse)} Cr, after trade would be ₹${toCr(newTeam1Purse)} Cr, shortfall ₹${toCr(shortfall)} Cr`);
        }
        if (newTeam2Purse < 0) {
          const shortfall = Math.abs(newTeam2Purse);
          parts.push(`${team2.teamName || 'Team 2'}: current ₹${toCr(team2Purse)} Cr, after trade would be ₹${toCr(newTeam2Purse)} Cr, shortfall ₹${toCr(shortfall)} Cr`);
        }
        return res.status(400).json({
          message: `Trade would result in negative purse balance. ${parts.join('; ')}.`
        });
      }

      // 2. TYPE LIMITS VALIDATION: Check if trade violates team composition rules
      const [team1Counts, team2Counts] = await Promise.all([
        getUserTypeCounts(team1._id),
        getUserTypeCounts(team2._id)
      ]);
      
      // Get player types for validation
      const [offeredPlayer, requestedPlayer] = await Promise.all([
        Player.findById(trade.offeredPlayer),
        Player.findById(trade.requestedPlayer)
      ]);

      if ((await isTradeLocked(offeredPlayer)) || (await isTradeLocked(requestedPlayer))) {
        return res.status(400).json({
          message: 'Trade blocked: one or both players are already trade-locked.'
        });
      }
      
      // Simulate post-trade counts
      if (offeredPlayer?.type) team1Counts[offeredPlayer.type] = Math.max(0, (team1Counts[offeredPlayer.type] || 0) - 1);
      if (requestedPlayer?.type) team1Counts[requestedPlayer.type] = (team1Counts[requestedPlayer.type] || 0) + 1;
      if (requestedPlayer?.type) team2Counts[requestedPlayer.type] = Math.max(0, (team2Counts[requestedPlayer.type] || 0) - 1);
      if (offeredPlayer?.type) team2Counts[offeredPlayer.type] = (team2Counts[offeredPlayer.type] || 0) + 1;

      if (wouldExceedTypeLimits(team1Counts)) {
        return res.status(400).json({ 
          message: `Trade violates ${team1.teamName || 'Team 1'} type limits (Emerald/Sapphire caps).` 
        });
      }
      if (wouldExceedTypeLimits(team2Counts)) {
        return res.status(400).json({ 
          message: `Trade violates ${team2.teamName || 'Team 2'} type limits (Emerald/Sapphire caps).` 
        });
      }

      // 3. TRADE USAGE VALIDATION: Check if teams have trades remaining
      if (clampTradesUsed(team1.tradesUsed) >= TRADE_SEASON_CAP) {
        return res.status(400).json({
          message: `${team1.teamName || 'Team 1'} has already used all ${TRADE_SEASON_CAP} trades.`,
        });
      }
      if (clampTradesUsed(team2.tradesUsed) >= TRADE_SEASON_CAP) {
        return res.status(400).json({
          message: `${team2.teamName || 'Team 2'} has already used all ${TRADE_SEASON_CAP} trades.`,
        });
      }

      // ALL VALIDATIONS PASSED - Proceed with trade execution
      console.log('✅ Trade validation passed - executing trade...');

      // Perform the swap same as players trade in players route
      offeredUP.userId = team2._id;
      requestedUP.userId = team1._id;
      offeredUP.updatedAt = new Date();
      requestedUP.updatedAt = new Date();

      // Update purses
      team1.purse = newTeam1Purse;
      team2.purse = newTeam2Purse;

      // CRITICAL FIX: Update boughtPlayers arrays
      // Remove offered player from team1 and add requested player
      team1.boughtPlayers = team1.boughtPlayers.filter(id => !id.equals(trade.offeredPlayer));
      team1.boughtPlayers.push(trade.requestedPlayer);
      
      // Remove requested player from team2 and add offered player
      team2.boughtPlayers = team2.boughtPlayers.filter(id => !id.equals(trade.requestedPlayer));
      team2.boughtPlayers.push(trade.offeredPlayer);

      // Save all updates
      await Promise.all([
        offeredUP.save(),
        requestedUP.save(),
        team1.save(),
        team2.save()
      ]);

      await setTradeLockOnPlayers([trade.offeredPlayer, trade.requestedPlayer]);

      trade.status = 'completed';
      trade.adminDecision = { status: 'approved', decidedBy: adminUserId, decidedAt: new Date(), note };

      // Increment BOTH teams' used trades counter when trade is actually completed
      try {
        await Promise.all([
          User.findByIdAndUpdate(trade.fromUser, { $inc: { tradesUsed: 1 } }),
          User.findByIdAndUpdate(trade.toUser, { $inc: { tradesUsed: 1 } })
        ]);
      } catch {}

      await autoRejectTradesInvolvingPlayers(
        adminUserId,
        [trade.offeredPlayer, trade.requestedPlayer],
        trade._id,
      );
    } else if (decision === 'reject') {
      trade.status = 'rejected';
      trade.adminDecision = { status: 'rejected', decidedBy: adminUserId, decidedAt: new Date(), note };
      
      // Admin rejection does NOT affect trade count - only completed trades count
      // No need to revert anything since tradesUsed is only incremented on approval
    } else {
      return res.status(400).json({ message: 'Invalid decision' });
    }

    await trade.save();
    res.json(trade);
  } catch (err) {
    console.error('Admin decide error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/trades/admin/unlock-players - Admin only: clear trade lock for specific players
router.post('/admin/unlock-players', async (req, res) => {
  try {
    const { adminUserId, playerIds } = req.body;
    if (!adminUserId || !Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ message: 'adminUserId and playerIds (array) required' });
    }
    const admin = await User.findById(adminUserId).select('isAdmin').lean();
    if (!admin?.isAdmin) {
      return res.status(403).json({ message: 'Only admin can unlock players' });
    }
    const result = await Player.updateMany(
      { _id: { $in: playerIds } },
      { $set: { tradeLocked: false, tradeLockedUntil: null } }
    );
    res.json({
      message: `Unlocked ${result.modifiedCount} player(s)`,
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('Unlock players error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/trades/admin/unlock-stale - Admin only: clear ALL stale locks (tradeLocked true but expired or missing until)
router.post('/admin/unlock-stale', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    if (!adminUserId) {
      return res.status(400).json({ message: 'adminUserId required' });
    }
    const admin = await User.findById(adminUserId).select('isAdmin').lean();
    if (!admin?.isAdmin) {
      return res.status(403).json({ message: 'Only admin can unlock players' });
    }
    const now = new Date();
    const result = await Player.updateMany(
      {
        tradeLocked: true,
        $or: [
          { tradeLockedUntil: null },
          { tradeLockedUntil: { $exists: false } },
          { tradeLockedUntil: { $lte: now } }
        ]
      },
      { $set: { tradeLocked: false, tradeLockedUntil: null } }
    );
    res.json({
      message: `Cleared ${result.modifiedCount} stale trade lock(s)`,
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('Unlock stale error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


