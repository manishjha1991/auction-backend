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
  clearActiveTradesForPlayers,
  TRADE_LOCK_HOURS,
} = require('../utils/tradeApprovalShared');
const { clampTradesUsed } = require('../utils/tradeConstants');
const { getTradeRules, assertPairAllowsNewProposal } = require('../utils/tradeRules');
const { invalidateCache } = require('../utils/cache');
const {
  getTradeApprovalBlockers,
  validateTradeForAdminApproval,
} = require('../utils/tradeApprovalBlockers');
const { createTradeProposal } = require('../utils/tradeProposalHelper');
const { assertHasTradeSlotRemaining } = require('../utils/tradeSlotReservation');
const { assertCanApproveTrades } = require('../utils/tradeAdminGuards');
const { executeApprovedTrade } = require('../utils/tradeExecution');
const { tryAutoApproveBundle, syncBundleStatus, attachTradeToBundle } = require('../utils/tradeBundleService');
const TradeApprovalAudit = require('../models/TradeApprovalAudit');
const { getClientIp } = require('../utils/network');
const tradeBundleRoutes = require('./tradeBundles');

router.use('/bundles', tradeBundleRoutes);
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
    const { fromUserId, offeredPlayerId, requestedPlayerId, bundleId } = req.body;
    const result = await createTradeProposal({
      fromUserId,
      offeredPlayerId,
      requestedPlayerId,
      bundleId: bundleId || null,
    });
    if (!result.ok) {
      return res.status(result.statusCode || 400).json({ message: result.message, ...result.extra });
    }
    if (bundleId && result.trade) {
      await attachTradeToBundle(bundleId, result.trade);
    }
    res.status(201).json(result.payload);
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
      try {
        await assertHasTradeSlotRemaining(byUserId);
      } catch (e) {
        return res.status(e.statusCode || 400).json({ message: e.message });
      }

      const blockers = await getTradeApprovalBlockers(trade);
      if (blockers.length) {
        return res.status(400).json({
          message: 'Cannot accept: trade would fail validation. Fix purse/roster issues first.',
          approvalWarnings: blockers,
        });
      }

      trade.status = 'admin_pending';
      trade.history.push({ byUser: byUserId, action: 'accept', message });
    } else if (decision === 'reject') {
      trade.status = 'rejected';
      trade.history.push({ byUser: byUserId, action: 'reject', message });
    } else {
      return res.status(400).json({ message: 'Invalid decision' });
    }

    await trade.save();

    let bundleAutoResult = null;
    if (decision === 'accept' && trade.bundleId) {
      await syncBundleStatus(trade.bundleId);
      bundleAutoResult = await tryAutoApproveBundle(trade.bundleId, getClientIp(req));
    }

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
    if (bundleAutoResult) {
      respondObj.bundleAutoResult = bundleAutoResult;
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

// GET approval audit log (all logged-in users via userId query)
router.get('/approval-audit', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const audits = await TradeApprovalAudit.find()
      .populate('decidedBy', 'name teamName email')
      .populate('bundleId', 'title shareCode')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json(audits);
  } catch (err) {
    console.error('Approval audit error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET trades pending admin approval
router.get('/admin/pending', async (req, res) => {
  try {
    const { adminUserId } = req.query;
    if (adminUserId) {
      const admin = await User.findById(adminUserId).select('isAdmin').lean();
      if (!admin?.isAdmin) {
        return res.status(403).json({ message: 'Only admin can view pending trades' });
      }
    }
    const trades = await TradeRequest.find({
      status: 'admin_pending',
      $or: [{ bundleId: null }, { bundleId: { $exists: false } }],
    })
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
    const { adminUserId } = req.query;
    if (adminUserId) {
      const admin = await User.findById(adminUserId).select('isAdmin').lean();
      if (!admin?.isAdmin) {
        return res.status(403).json({ message: 'Only admin can view trade history' });
      }
    }
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

    if (trade.bundleId) {
      return res.status(400).json({
        message: 'Bundled trades auto-approve as a group when all legs are accepted. Use bundle reject if needed.',
      });
    }

    if (trade.status !== 'admin_pending') {
      return res.status(400).json({ message: 'Only admin_pending trades can be decided.' });
    }

    if (decision === 'approve') {
      await assertCanApproveTrades(adminUserId);

      const result = await executeApprovedTrade(trade, adminUserId, note);
      if (!result.ok) {
        return res.status(400).json({ message: result.blockers.join(' ') });
      }

      await TradeApprovalAudit.create({
        type: 'standalone_approve',
        tradeId: trade._id,
        decidedBy: adminUserId,
        clientIp: getClientIp(req),
        note: note || '',
      });

      return res.json(result.trade);
    }

    if (decision === 'reject') {
      await assertCanApproveTrades(adminUserId);

      trade.status = 'rejected';
      trade.adminDecision = { status: 'rejected', decidedBy: adminUserId, decidedAt: new Date(), note };

      await autoRejectTradesInvolvingPlayers(
        adminUserId,
        [trade.offeredPlayer, trade.requestedPlayer],
        trade._id,
        'Auto-rejected: admin rejected related trade involving these players',
      );

      await trade.save();

      await TradeApprovalAudit.create({
        type: 'standalone_reject',
        tradeId: trade._id,
        decidedBy: adminUserId,
        clientIp: getClientIp(req),
        note: note || '',
      });

      return res.json(trade);
    }

    return res.status(400).json({ message: 'Invalid decision' });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error('Admin decide error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/trades/admin/clear-stuck-for-players - Admin: reject active trades blocking named players
router.post('/admin/clear-stuck-for-players', async (req, res) => {
  try {
    const { adminUserId, playerIds, playerNames } = req.body;
    if (!adminUserId) {
      return res.status(400).json({ message: 'adminUserId required' });
    }
    const admin = await User.findById(adminUserId).select('isAdmin').lean();
    if (!admin?.isAdmin) {
      return res.status(403).json({ message: 'Only admin can clear stuck player trades' });
    }

    let ids = Array.isArray(playerIds) ? playerIds.filter(Boolean) : [];
    if (Array.isArray(playerNames) && playerNames.length > 0) {
      for (const raw of playerNames) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const match = await Player.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
          .select('_id name')
          .lean();
        if (match) ids.push(match._id);
      }
    }
    ids = [...new Set(ids.map(String))];
    if (ids.length === 0) {
      return res.status(400).json({ message: 'playerIds or playerNames required' });
    }

    const result = await clearActiveTradesForPlayers(adminUserId, ids);
    res.json({
      message: result.cleared
        ? `Cleared ${result.cleared} active trade request(s)`
        : 'No active trade requests found for these players',
      ...result,
      playerIds: ids,
    });
  } catch (err) {
    console.error('Clear stuck player trades error', err);
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


