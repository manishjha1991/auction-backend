/**
 * Commissioner / admin: direct player-for-player trade, pick from unsold, release — with preview + execute.
 *
 * Player trade (swap): after confirmation, matches /api/trades admin approve — same purse math, type limits,
 * 48h trade lock, tradesUsed +1 for BOTH teams, auto-reject of other active TradeRequests involving those players.
 * Skips only: creating a TradeRequest and counter-user acceptance (admin acts for both sides).
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const Bid = require('../models/Bid');
const {
  isTradeLocked,
  setTradeLockOnPlayers,
  autoRejectTradesInvolvingPlayers,
} = require('../utils/tradeApprovalShared');

const TRADES_USED_CAP = 6; // same as routes/trades.js (comment says "4 trades" but code checks 6)

const CRORE = 10_000_000;
const TYPE_LIMITS = { Sapphire: 2, Gold: 8, Emerald: 4, Silver: 6 };
const COMBINED_ES_LIMIT = 5;

async function requireAdmin(adminUserId) {
  if (!adminUserId) {
    const e = new Error('adminUserId is required');
    e.status = 400;
    throw e;
  }
  const admin = await User.findById(adminUserId).includeInactive().select('isAdmin');
  if (!admin?.isAdmin) {
    const e = new Error('Only admins can use roster tools');
    e.status = 403;
    throw e;
  }
}

function purseNum(doc) {
  if (!doc?.purse) return 0;
  return parseFloat(doc.purse.toString());
}

function toCr(n) {
  return Number((Number(n) / CRORE).toFixed(2));
}

async function getUserTypeCounts(userId) {
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
  const es = (counts.Emerald || 0) + (counts.Sapphire || 0);
  if (es > COMBINED_ES_LIMIT) return true;
  return false;
}

// ---------- Teams & rosters ----------
router.get('/teams', async (req, res) => {
  try {
    await requireAdmin(req.query.adminUserId);
    const teams = await User.find({ isAdmin: { $ne: true }, isActive: { $ne: false } })
      .select('_id teamName abbreviation purse')
      .sort({ teamName: 1 })
      .lean();
    const withPurse = teams.map((t) => ({
      ...t,
      purseCr: toCr(purseNum(t)),
    }));
    res.json(withPurse);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

router.get('/team/:userId/players', async (req, res) => {
  try {
    await requireAdmin(req.query.adminUserId);
    const { userId } = req.params;
    const ups = await UserPlayer.find({ userId, isActive: true })
      .populate('playerId', 'name type role basePrice')
      .lean();
    const list = ups
      .filter((u) => u.playerId)
      .map((u) => ({
        userPlayerId: u._id,
        playerId: u.playerId._id,
        name: u.playerId.name,
        type: u.playerId.type,
        role: u.playerId.role,
        bidValue: u.bidValue,
        bidValueCr: toCr(u.bidValue),
      }));
    res.json(list);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

router.get('/unsold', async (req, res) => {
  try {
    await requireAdmin(req.query.adminUserId);
    const search = (req.query.search || '').trim();
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const filter = {
      isSold: false,
      isActive: false,
      $or: [{ releasedAt: null }, { releasedAt: { $lt: fortyEightHoursAgo } }],
    };
    if (search) filter.name = { $regex: search, $options: 'i' };
    const items = await Player.find(filter)
      .select('name type role basePrice')
      .sort({ name: 1 })
      .limit(200)
      .lean();
    res.json({
      items: items.map((p) => ({
        ...p,
        basePriceCr: toCr(p.basePrice || 0),
      })),
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

// ---------- Trade ----------
router.post('/trade/preview', async (req, res) => {
  try {
    const { adminUserId, player1Id, player2Id } = req.body;
    await requireAdmin(adminUserId);
    if (!player1Id || !player2Id || String(player1Id) === String(player2Id)) {
      return res.status(400).json({ message: 'Two different player IDs required' });
    }

    const [up1, up2] = await Promise.all([
      UserPlayer.findOne({ playerId: player1Id, isActive: true }).populate('userId').populate('playerId', 'name type'),
      UserPlayer.findOne({ playerId: player2Id, isActive: true }).populate('userId').populate('playerId', 'name type'),
    ]);
    if (!up1 || !up2) {
      return res.status(404).json({ message: 'One or both players are not on an active roster' });
    }
    const team1 = up1.userId;
    const team2 = up2.userId;
    if (String(team1._id) === String(team2._id)) {
      return res.status(400).json({ message: 'Both players are on the same team — pick two different teams' });
    }

    const [fullTeam1, fullTeam2, playerDoc1, playerDoc2] = await Promise.all([
      User.findById(team1._id).select('teamName abbreviation purse tradesUsed'),
      User.findById(team2._id).select('teamName abbreviation purse tradesUsed'),
      Player.findById(player1Id),
      Player.findById(player2Id),
    ]);

    const v1 = Number(up1.bidValue || 0);
    const v2 = Number(up2.bidValue || 0);
    const p1 = purseNum(fullTeam1);
    const p2 = purseNum(fullTeam2);
    const newP1 = p1 + v1 - v2;
    const newP2 = p2 + v2 - v1;

    const [c1, c2] = await Promise.all([getUserTypeCounts(team1._id), getUserTypeCounts(team2._id)]);
    const pl1 = up1.playerId;
    const pl2 = up2.playerId;
    if (pl1?.type) c1[pl1.type] = Math.max(0, (c1[pl1.type] || 0) - 1);
    if (pl2?.type) c1[pl2.type] = (c1[pl2.type] || 0) + 1;
    if (pl2?.type) c2[pl2.type] = Math.max(0, (c2[pl2.type] || 0) - 1);
    if (pl1?.type) c2[pl1.type] = (c2[pl1.type] || 0) + 1;

    const errors = [];
    if (newP1 < 0) errors.push(`${team1.teamName || 'Team A'} purse would be negative (₹${toCr(newP1)} Cr)`);
    if (newP2 < 0) errors.push(`${team2.teamName || 'Team B'} purse would be negative (₹${toCr(newP2)} Cr)`);
    if (wouldExceedTypeLimits(c1)) errors.push(`${team1.teamName || 'Team A'} would exceed type limits after trade`);
    if (wouldExceedTypeLimits(c2)) errors.push(`${team2.teamName || 'Team B'} would exceed type limits after trade`);

    if ((await isTradeLocked(playerDoc1)) || (await isTradeLocked(playerDoc2))) {
      errors.push('One or both players are trade-locked (same rule as Admin Trades approval)');
    }
    if (Number(fullTeam1?.tradesUsed || 0) >= TRADES_USED_CAP) {
      errors.push(`${fullTeam1.teamName || 'Team A'} has reached the trade-usage cap (${TRADES_USED_CAP})`);
    }
    if (Number(fullTeam2?.tradesUsed || 0) >= TRADES_USED_CAP) {
      errors.push(`${fullTeam2.teamName || 'Team B'} has reached the trade-usage cap (${TRADES_USED_CAP})`);
    }

    res.json({
      ok: errors.length === 0,
      errors,
      team1: {
        id: team1._id,
        name: team1.teamName,
        abbreviation: team1.abbreviation,
        playerOut: { id: pl1?._id, name: pl1?.name, type: pl1?.type, salaryCr: toCr(v1) },
        playerIn: { id: pl2?._id, name: pl2?.name, type: pl2?.type, salaryCr: toCr(v2) },
        purseBeforeCr: toCr(p1),
        purseAfterCr: toCr(newP1),
        purseDeltaCr: toCr(newP1 - p1),
      },
      team2: {
        id: team2._id,
        name: team2.teamName,
        abbreviation: team2.abbreviation,
        playerOut: { id: pl2?._id, name: pl2?.name, type: pl2?.type, salaryCr: toCr(v2) },
        playerIn: { id: pl1?._id, name: pl1?.name, type: pl1?.type, salaryCr: toCr(v1) },
        purseBeforeCr: toCr(p2),
        purseAfterCr: toCr(newP2),
        purseDeltaCr: toCr(newP2 - p2),
      },
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

router.post('/trade/execute', async (req, res) => {
  try {
    const { adminUserId, player1Id, player2Id } = req.body;
    await requireAdmin(adminUserId);
    if (!player1Id || !player2Id) {
      return res.status(400).json({ message: 'player1Id and player2Id required' });
    }

    const [up1, up2] = await Promise.all([
      UserPlayer.findOne({ playerId: player1Id, isActive: true }).populate('userId').populate('playerId', 'name type'),
      UserPlayer.findOne({ playerId: player2Id, isActive: true }).populate('userId').populate('playerId', 'name type'),
    ]);
    if (!up1 || !up2) {
      return res.status(404).json({ message: 'One or both players not found on active rosters' });
    }
    const team1 = await User.findById(up1.userId._id || up1.userId);
    const team2 = await User.findById(up2.userId._id || up2.userId);
    if (String(team1._id) === String(team2._id)) {
      return res.status(400).json({ message: 'Same team' });
    }

    const v1 = Number(up1.bidValue || 0);
    const v2 = Number(up2.bidValue || 0);
    const p1 = purseNum(team1);
    const p2 = purseNum(team2);
    const newP1 = p1 + v1 - v2;
    const newP2 = p2 + v2 - v1;
    if (newP1 < 0 || newP2 < 0) {
      return res.status(400).json({ message: 'Trade would leave a negative purse — use preview first' });
    }

    const [c1, c2] = await Promise.all([getUserTypeCounts(team1._id), getUserTypeCounts(team2._id)]);
    const pl1 = await Player.findById(player1Id);
    const pl2 = await Player.findById(player2Id);
    if (pl1?.type) c1[pl1.type] = Math.max(0, (c1[pl1.type] || 0) - 1);
    if (pl2?.type) c1[pl2.type] = (c1[pl2.type] || 0) + 1;
    if (pl2?.type) c2[pl2.type] = Math.max(0, (c2[pl2.type] || 0) - 1);
    if (pl1?.type) c2[pl1.type] = (c2[pl1.type] || 0) + 1;
    if (wouldExceedTypeLimits(c1) || wouldExceedTypeLimits(c2)) {
      return res.status(400).json({ message: 'Trade would violate type limits' });
    }

    const [lockP1, lockP2] = await Promise.all([Player.findById(player1Id), Player.findById(player2Id)]);
    if ((await isTradeLocked(lockP1)) || (await isTradeLocked(lockP2))) {
      return res.status(400).json({
        message: 'Trade blocked: one or both players are already trade-locked (same as Admin Trades).',
      });
    }
    if (Number(team1.tradesUsed || 0) >= TRADES_USED_CAP || Number(team2.tradesUsed || 0) >= TRADES_USED_CAP) {
      return res.status(400).json({
        message: `One or both teams have reached the trade-usage cap (${TRADES_USED_CAP}).`,
      });
    }

    up1.userId = team2._id;
    up2.userId = team1._id;
    up1.updatedAt = new Date();
    up2.updatedAt = new Date();

    // Same assignment style as routes/trades.js admin approve (numeric purse)
    team1.purse = newP1;
    team2.purse = newP2;

    team1.boughtPlayers = (team1.boughtPlayers || []).filter((id) => !id.equals(player1Id));
    team1.boughtPlayers.push(player2Id);
    team2.boughtPlayers = (team2.boughtPlayers || []).filter((id) => !id.equals(player2Id));
    team2.boughtPlayers.push(player1Id);

    await Promise.all([up1.save(), up2.save(), team1.save(), team2.save()]);

    await setTradeLockOnPlayers([player1Id, player2Id]);

    try {
      await Promise.all([
        User.findByIdAndUpdate(team1._id, { $inc: { tradesUsed: 1 } }),
        User.findByIdAndUpdate(team2._id, { $inc: { tradesUsed: 1 } }),
      ]);
    } catch (_) {}

    const otherRequestsRejected = await autoRejectTradesInvolvingPlayers(
      adminUserId,
      [player1Id, player2Id],
      null,
    );

    res.json({
      ok: true,
      message: 'Trade completed (same post-steps as Admin Trades approval)',
      team1: { name: team1.teamName, purseAfterCr: toCr(newP1) },
      team2: { name: team2.teamName, purseAfterCr: toCr(newP2) },
      otherTradeRequestsRejected: otherRequestsRejected,
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

// ---------- Pick (unsold → team) ----------
router.post('/pick/preview', async (req, res) => {
  try {
    const { adminUserId, teamUserId, playerId } = req.body;
    await requireAdmin(adminUserId);
    if (!teamUserId || !playerId) {
      return res.status(400).json({ message: 'teamUserId and playerId required' });
    }

    const [user, player] = await Promise.all([User.findById(teamUserId), Player.findById(playerId)]);
    if (!user || !player) return res.status(404).json({ message: 'Team or player not found' });
    if (player.isSold) return res.status(400).json({ message: 'Player is already sold' });

    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    if (player.releasedAt && new Date(player.releasedAt) > fortyEightHoursAgo) {
      return res.status(400).json({ message: 'Player was released in the last 48h — pick blocked' });
    }

    const basePrice = Number(player.basePrice || 0);
    const purse = purseNum(user);
    const after = purse - basePrice;

    const counts = await getUserTypeCounts(user._id);
    const atTypeLimit = (counts[player.type] || 0) >= (TYPE_LIMITS[player.type] ?? 99);
    const sim = { ...counts };
    sim[player.type] = (sim[player.type] || 0) + 1;

    const errors = [];
    if (after < 0) errors.push(`Insufficient purse: need ₹${toCr(basePrice)} Cr, have ₹${toCr(purse)} Cr`);
    if (atTypeLimit) errors.push(`Team already at max ${player.type} players (${TYPE_LIMITS[player.type]})`);
    if (wouldExceedTypeLimits(sim)) {
      errors.push('Would exceed Emerald/Sapphire combined or per-type cap');
    }

    res.json({
      ok: errors.length === 0,
      errors,
      team: { id: user._id, name: user.teamName, abbreviation: user.abbreviation },
      player: {
        id: player._id,
        name: player.name,
        type: player.type,
        role: player.role,
        basePriceCr: toCr(basePrice),
      },
      purseBeforeCr: toCr(purse),
      purseAfterCr: toCr(after),
      costCr: toCr(basePrice),
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

router.post('/pick/execute', async (req, res) => {
  try {
    const { adminUserId, teamUserId, playerId } = req.body;
    await requireAdmin(adminUserId);
    if (!teamUserId || !playerId) {
      return res.status(400).json({ message: 'teamUserId and playerId required' });
    }

    const existing = await UserPlayer.findOne({ playerId, isActive: true });
    if (existing) {
      return res.status(400).json({ message: 'Player already assigned to a team' });
    }

    const [user, player] = await Promise.all([User.findById(teamUserId), Player.findById(playerId)]);
    if (!user || !player) return res.status(404).json({ message: 'Team or player not found' });
    if (player.isSold) return res.status(400).json({ message: 'Player already sold' });

    const basePrice = Number(player.basePrice || 0);
    const purse = purseNum(user);
    if (purse < basePrice) return res.status(400).json({ message: 'Insufficient purse' });

    const counts = await getUserTypeCounts(user._id);
    if ((counts[player.type] || 0) >= TYPE_LIMITS[player.type]) {
      return res.status(400).json({ message: `Max ${player.type} players reached` });
    }
    const sim = { ...counts };
    sim[player.type] = (sim[player.type] || 0) + 1;
    if (wouldExceedTypeLimits(sim)) {
      return res.status(400).json({ message: 'Would exceed roster type limits' });
    }

    const newPurse = purse - basePrice;
    user.purse = mongoose.Types.Decimal128.fromString(String(newPurse));
    user.currentBids = (user.currentBids || []).filter((cb) => !cb.playerId.equals(playerId));
    if (!user.boughtPlayers.some((id) => id.equals(playerId))) {
      user.boughtPlayers.push(playerId);
    }
    await user.save();

    await UserPlayer.create({
      playerId,
      userId: teamUserId,
      bidValue: basePrice,
      isActive: true,
    });

    // Persist bid fields even if not on strict Player schema (matches bid/sold behaviour)
    await Player.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(playerId)) },
      {
        $set: {
          isSold: true,
          isActive: true,
          currentBid: basePrice,
          currentBidder: new mongoose.Types.ObjectId(String(teamUserId)),
        },
      },
    );

    await Bid.deleteMany({ playerId });

    res.json({
      ok: true,
      message: 'Pick completed',
      team: { name: user.teamName, purseAfterCr: toCr(newPurse) },
      player: { name: player.name, costCr: toCr(basePrice) },
    });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({ message: 'Duplicate roster record — player may already be assigned' });
    }
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

// ---------- Release ----------
router.post('/release/preview', async (req, res) => {
  try {
    const { adminUserId, teamUserId, playerId } = req.body;
    await requireAdmin(adminUserId);
    if (!teamUserId || !playerId) {
      return res.status(400).json({ message: 'teamUserId and playerId required' });
    }

    const up = await UserPlayer.findOne({ userId: teamUserId, playerId, isActive: true })
      .populate('playerId', 'name type role')
      .lean();
    if (!up) return res.status(404).json({ message: 'Team does not own this player' });

    const user = await User.findById(teamUserId).lean();
    const refund = Number(up.bidValue || 0);
    const purse = purseNum(user);
    const after = purse + refund;
    const activeCount = await UserPlayer.countDocuments({ userId: teamUserId, isActive: true });

    res.json({
      ok: true,
      team: { id: user._id, name: user.teamName },
      player: {
        id: up.playerId._id,
        name: up.playerId.name,
        type: up.playerId.type,
        refundCr: toCr(refund),
      },
      purseBeforeCr: toCr(purse),
      purseAfterCr: toCr(after),
      refundCr: toCr(refund),
      activeRosterAfter: activeCount - 1,
      warnings:
        activeCount - 1 < 16
          ? [`Roster will have ${activeCount - 1} active players (below 16)`]
          : [],
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

router.post('/release/execute', async (req, res) => {
  try {
    const { adminUserId, teamUserId, playerId } = req.body;
    await requireAdmin(adminUserId);

    const up = await UserPlayer.findOne({ userId: teamUserId, playerId, isActive: true });
    if (!up) return res.status(404).json({ message: 'Ownership not found' });

    const bidValue = Number(up.bidValue || 0);
    up.isActive = false;
    up.updatedAt = new Date();
    await up.save();

    if (bidValue > 0) {
      await User.findByIdAndUpdate(teamUserId, { $inc: { purse: bidValue } });
    }

    await Player.findByIdAndUpdate(playerId, {
      $set: {
        isSold: false,
        isActive: false,
        currentBid: null,
        currentBidder: null,
        tradeLocked: false,
        tradeLockedUntil: null,
        releasedAt: new Date(),
      },
    });

    await User.findByIdAndUpdate(teamUserId, { $pull: { boughtPlayers: playerId } });
    await Bid.deleteMany({ playerId });

    const user = await User.findById(teamUserId);
    res.json({
      ok: true,
      message: 'Player released',
      team: { name: user.teamName, purseAfterCr: toCr(purseNum(user)) },
      refundedCr: toCr(bidValue),
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

module.exports = router;
