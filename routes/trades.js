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
  TRADE_LOCK_HOURS,
} = require('../utils/tradeApprovalShared');
const { clampTradesUsed } = require('../utils/tradeConstants');
const { getTradeRules, assertPairAllowsNewProposal } = require('../utils/tradeRules');
const { invalidateCache } = require('../utils/cache');
const {
  getTradeApprovalBlockers,
  validateTradeForAdminApproval,
} = require('../utils/tradeApprovalBlockers');
const {
  TRADE_DECIDABLE_STATUSES,
  isAdminDecidableStatus,
  undecidableAdminMessage,
  claimAdminDecision,
  rollbackAdminDecisionClaim,
} = require('../utils/adminDecideGuard');
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

    const rules = await getTradeRules();

    // Enforce max active outgoing trade requests per user (same cap as season trades)
    const activeCount = await TradeRequest.countDocuments({
      fromUser: fromUserId,
      status: { $in: ['pending', 'counter', 'admin_pending'] }
    });
    if (activeCount >= rules.maxActiveOutgoingTrades) {
      return res.status(400).json({
        message: `Trade limit reached: You can have at most ${rules.maxActiveOutgoingTrades} active trade requests.`,
      });
    }

    // Enforce total trade usage cap (completed trades + approved releases → tradesUsed)
    // 🚀 PERFORMANCE: Use .lean() for read-only query
    const proposer = await User.findById(fromUserId).select('tradesUsed').lean();
    if (proposer && clampTradesUsed(proposer.tradesUsed) >= rules.tradeSeasonCap) {
      return res.status(400).json({ message: `You have used all ${rules.tradeSeasonCap} trades.` });
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

    try {
      await assertPairAllowsNewProposal(
        fromUserId,
        requestedOwner._id,
        rules.maxTradesPerOpponentPair
      );
    } catch (e) {
      if (e.statusCode) return res.status(e.statusCode).json({ message: e.message });
      throw e;
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

    const lockHint = `Trade-locked for ${TRADE_LOCK_HOURS} hours after a completed trade or after being picked from unsold`;
    if (await isTradeLocked(offeredPlayer)) {
      return res.status(409).json({
        message: `Your offered player cannot be traded yet (${lockHint}).`,
      });
    }
    if (await isTradeLocked(requestedPlayer)) {
      return res.status(409).json({
        message: `The requested player cannot be traded yet (${lockHint}).`,
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
    const populatedDoc = await TradeRequest.findById(trade._id)
      .populate('fromUser', 'name teamName')
      .populate('toUser', 'name teamName')
      .populate('offeredPlayer', 'name type role profilePicture')
      .populate('requestedPlayer', 'name type role profilePicture');

    const createdObj = populatedDoc.toObject({ virtuals: true });
    createdObj.approvalWarnings = await getTradeApprovalBlockers(populatedDoc);
    res.status(201).json(createdObj);
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
      .populate('offeredPlayer', 'name type role profilePicture')
      .populate('requestedPlayer', 'name type role profilePicture');
    const respondObj = populated.toObject({ virtuals: true });
    if (['pending', 'counter', 'admin_pending'].includes(populated.status)) {
      respondObj.approvalWarnings = await getTradeApprovalBlockers(populated);
    } else {
      respondObj.approvalWarnings = [];
    }
    res.json(respondObj);
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
      .populate('offeredPlayer', 'name type role profilePicture')
      .populate('requestedPlayer', 'name type role profilePicture');
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
      .populate('offeredPlayer', 'name type role profilePicture')
      .populate('requestedPlayer', 'name type role profilePicture')
      .populate('history.byUser', 'name teamName')
      .populate('history.offeredPlayer', 'name type role profilePicture')
      .populate('history.requestedPlayer', 'name type role profilePicture')
      .sort({ createdAt: -1 });

    const payload = await Promise.all(
      trades.map(async (t) => {
        const o = t.toObject({ virtuals: true });
        if (['pending', 'counter', 'admin_pending'].includes(t.status)) {
          o.approvalWarnings = await getTradeApprovalBlockers(t);
        } else {
          o.approvalWarnings = [];
        }
        return o;
      })
    );
    res.json(payload);
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
      .populate('offeredPlayer', 'name type role profilePicture')
      .populate('requestedPlayer', 'name type role profilePicture')
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
      .populate('offeredPlayer', 'name type role profilePicture')
      .populate('requestedPlayer', 'name type role profilePicture')
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
    if (!isAdminDecidableStatus(trade.status, TRADE_DECIDABLE_STATUSES)) {
      return res.status(409).json({ message: undecidableAdminMessage('trade', trade.status) });
    }

    if (decision === 'approve') {
      const validation = await validateTradeForAdminApproval(trade);
      if (!validation.ok) {
        return res.status(400).json({ message: validation.blockers.join(' ') });
      }

      const {
        team1,
        team2,
        offeredUP,
        requestedUP,
        newTeam1Purse,
        newTeam2Purse,
      } = validation;

      const adminDecision = {
        status: 'approved',
        decidedBy: adminUserId,
        decidedAt: new Date(),
        note,
      };
      // Claim before roster/purse mutation so a second decide cannot reverse the swap.
      const claimed = await claimAdminDecision(TradeRequest, tradeId, TRADE_DECIDABLE_STATUSES, {
        terminalStatus: 'completed',
        adminDecision,
      });
      if (!claimed) {
        const latest = await TradeRequest.findById(tradeId).select('status').lean();
        return res.status(409).json({
          message: undecidableAdminMessage('trade', latest?.status || 'unknown'),
        });
      }

      try {
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
        try {
          invalidateCache('players:data');
        } catch (_) {}

        // Each completed trade counts as one slot per team. A later unsold pick (e.g. to refill Sapphire after a cross-tier swap) is a separate slot unless it pairs to a same-tier release — see routes/picks.js.
        try {
          await Promise.all([
            User.findByIdAndUpdate(trade.fromUser, { $inc: { tradesUsed: 1 } }),
            User.findByIdAndUpdate(trade.toUser, { $inc: { tradesUsed: 1 } }),
          ]);
        } catch {}

        await autoRejectTradesInvolvingPlayers(
          adminUserId,
          [trade.offeredPlayer, trade.requestedPlayer],
          trade._id,
        );
      } catch (execErr) {
        await rollbackAdminDecisionClaim(TradeRequest, claimed);
        throw execErr;
      }

      const completed = await TradeRequest.findById(tradeId);
      return res.json(completed);
    }

    if (decision === 'reject') {
      const adminDecision = {
        status: 'rejected',
        decidedBy: adminUserId,
        decidedAt: new Date(),
        note,
      };
      const claimed = await claimAdminDecision(TradeRequest, tradeId, TRADE_DECIDABLE_STATUSES, {
        terminalStatus: 'rejected',
        adminDecision,
      });
      if (!claimed) {
        const latest = await TradeRequest.findById(tradeId).select('status').lean();
        return res.status(409).json({
          message: undecidableAdminMessage('trade', latest?.status || 'unknown'),
        });
      }
      // Admin rejection does NOT affect trade count - only completed trades count
      const rejected = await TradeRequest.findById(tradeId);
      return res.json(rejected);
    }

    return res.status(400).json({ message: 'Invalid decision' });
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


