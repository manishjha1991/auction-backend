const express = require('express');
const router = express.Router();
const TradeRequest = require('../models/TradeRequest');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
// Limits similar to bidding constraints
const TYPE_LIMITS = { Sapphire: 2, Gold: 8, Emerald: 4, Silver: 6 };
const COMBINED_ES_LIMIT = 5; // Emerald + Sapphire combined

async function getUserTypeCounts(userId) {
  const ups = await UserPlayer.find({ userId, isActive: true }).populate('playerId', 'type');
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
  const up = await UserPlayer.findOne({ playerId, isActive: true }).populate('userId');
  return up ? up.userId : null;
}

// POST create trade request
router.post('/', async (req, res) => {
  try {
    const { fromUserId, offeredPlayerId, requestedPlayerId } = req.body;
    if (!fromUserId || !offeredPlayerId || !requestedPlayerId) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    // Enforce max 4 active outgoing trade requests for a user
    const activeCount = await TradeRequest.countDocuments({
      fromUser: fromUserId,
      status: { $in: ['pending', 'counter', 'admin_pending'] }
    });
    if (activeCount >= 4) {
      return res.status(400).json({ message: 'Trade limit reached: You can have at most 4 active trade requests.' });
    }

    // Enforce total trade usage cap (no more than 4 trades overall for the proposer)
    const proposer = await User.findById(fromUserId).select('tradesUsed');
    if (proposer && Number(proposer.tradesUsed || 0) >= 4) {
      return res.status(400).json({ message: 'You have used all 4 trades.' });
    }

    const [fromUser, offeredOwner, requestedOwner] = await Promise.all([
      User.findById(fromUserId),
      getOwnerOfPlayer(offeredPlayerId),
      getOwnerOfPlayer(requestedPlayerId)
    ]);

    if (!fromUser || !offeredOwner || !requestedOwner) {
      return res.status(404).json({ message: 'User or players not found.' });
    }

    if (String(offeredOwner._id) !== String(fromUser._id)) {
      return res.status(403).json({ message: 'You do not own the offered player.' });
    }

    if (String(requestedOwner._id) === String(fromUser._id)) {
      return res.status(400).json({ message: 'Requested player is already in your team.' });
    }

    const [offeredPlayer, requestedPlayer, offeredUP, requestedUP] = await Promise.all([
      Player.findById(offeredPlayerId),
      Player.findById(requestedPlayerId),
      UserPlayer.findOne({ playerId: offeredPlayerId, isActive: true }).populate('userId'),
      UserPlayer.findOne({ playerId: requestedPlayerId, isActive: true }).populate('userId')
    ]);

    if (!offeredUP || !requestedUP) {
      return res.status(400).json({ message: 'One or both players are not available for trade.' });
    }

    // Removed tradeLocked guard per updated requirement; a newly traded player can be traded again later

    // Purse validation: ensure both teams would not go negative after swap
    const offeredValue = Number(offeredUP.bidValue || 0);
    const requestedValue = Number(requestedUP.bidValue || 0);
    const fromPurse = Number(fromUser.purse || 0);
    const toPurse = Number(requestedOwner.purse || 0);

    const newFromPurse = fromPurse + offeredValue - requestedValue;
    const newToPurse = toPurse + requestedValue - offeredValue;
    if (Number.isNaN(newFromPurse) || Number.isNaN(newToPurse)) {
      return res.status(400).json({ message: 'Invalid purse or bid values for trade validation.' });
    }
    if (newFromPurse < 0 || newToPurse < 0) {
      return res.status(400).json({
        message: 'Trade not allowed: purse balance would go negative for one or both teams.'
      });
    }

    // Type limits validation: simulate post-trade counts
    const [fromCounts, toCounts] = await Promise.all([
      getUserTypeCounts(fromUser._id),
      getUserTypeCounts(requestedOwner._id)
    ]);
    if (offeredPlayer?.type) fromCounts[offeredPlayer.type] = Math.max(0, (fromCounts[offeredPlayer.type] || 0) - 1);
    if (requestedPlayer?.type) fromCounts[requestedPlayer.type] = (fromCounts[requestedPlayer.type] || 0) + 1;
    if (requestedPlayer?.type) toCounts[requestedPlayer.type] = Math.max(0, (toCounts[requestedPlayer.type] || 0) - 1);
    if (offeredPlayer?.type) toCounts[offeredPlayer.type] = (toCounts[offeredPlayer.type] || 0) + 1;

    if (wouldExceedTypeLimits(fromCounts)) {
      return res.status(400).json({ message: 'Trade violates your team type limits (Emerald/Sapphire caps).' });
    }
    if (wouldExceedTypeLimits(toCounts)) {
      return res.status(400).json({ message: "Trade violates recipient's team type limits." });
    }

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

    res.status(201).json(trade);
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
    if (String(trade.toUser) !== String(byUserId)) {
      return res.status(403).json({ message: 'Only the recipient can respond.' });
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
    res.json(trade);
  } catch (err) {
    console.error('Respond trade error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST negotiate (counter) with a counter offered player
router.post('/:tradeId/negotiate', async (req, res) => {
  try {
    const { tradeId } = req.params;
    const { byUserId, counterOfferedPlayerId } = req.body;
    const trade = await TradeRequest.findById(tradeId);
    if (!trade) return res.status(404).json({ message: 'Trade not found' });
    if (String(trade.toUser) !== String(byUserId)) {
      return res.status(403).json({ message: 'Only the recipient can negotiate.' });
    }

    const owner = await getOwnerOfPlayer(counterOfferedPlayerId);
    if (!owner || String(owner._id) !== String(byUserId)) {
      return res.status(400).json({ message: 'You do not own the counter offered player.' });
    }

    trade.status = 'counter';
    trade.history.push({ byUser: byUserId, action: 'counter', message: 'Counter proposal', offeredPlayer: trade.offeredPlayer, requestedPlayer: counterOfferedPlayerId });
    // Swap requestedPlayer to the counter request for clarity in UI
    trade.requestedPlayer = counterOfferedPlayerId;
    await trade.save();
    res.json(trade);
  } catch (err) {
    console.error('Negotiate trade error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
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
    res.json(trade);
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
      // Perform the swap same as players trade in players route
      const [offeredUP, requestedUP] = await Promise.all([
        UserPlayer.findOne({ playerId: trade.offeredPlayer, isActive: true }).populate('userId'),
        UserPlayer.findOne({ playerId: trade.requestedPlayer, isActive: true }).populate('userId')
      ]);
      if (!offeredUP || !requestedUP) {
        return res.status(400).json({ message: 'Players not available for trade' });
      }
      const team1 = offeredUP.userId;
      const team2 = requestedUP.userId;

      // Swap owners
      offeredUP.userId = team2._id;
      requestedUP.userId = team1._id;
      offeredUP.updatedAt = new Date();
      requestedUP.updatedAt = new Date();

      await Promise.all([offeredUP.save(), requestedUP.save()]);

      // Lock both players from further trading
      await Promise.all([
        Player.findByIdAndUpdate(trade.offeredPlayer, { $set: { tradeLocked: true } }),
        Player.findByIdAndUpdate(trade.requestedPlayer, { $set: { tradeLocked: true } })
      ]);

      trade.status = 'completed';
      trade.adminDecision = { status: 'approved', decidedBy: adminUserId, decidedAt: new Date(), note };

      // Increment trader's used trades counter
      try {
        await User.findByIdAndUpdate(trade.fromUser, { $inc: { tradesUsed: 1 } });
      } catch {}

      // Auto-reject any other active trades involving either of these players
      const activeStatuses = ['pending', 'counter', 'admin_pending'];
      const others = await TradeRequest.find({
        _id: { $ne: trade._id },
        status: { $in: activeStatuses },
        $or: [
          { offeredPlayer: { $in: [trade.offeredPlayer, trade.requestedPlayer] } },
          { requestedPlayer: { $in: [trade.offeredPlayer, trade.requestedPlayer] } }
        ]
      });
      for (const o of others) {
        o.status = 'rejected';
        o.history.push({ byUser: adminUserId, action: 'reject', message: 'Auto-rejected: player traded to another team' });
        await o.save();
      }
    } else if (decision === 'reject') {
      trade.status = 'rejected';
      trade.adminDecision = { status: 'rejected', decidedBy: adminUserId, decidedAt: new Date(), note };
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

module.exports = router;


