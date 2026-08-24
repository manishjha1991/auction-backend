/**
 * Commissioner / admin: direct player-for-player trade, pick from unsold, release — with preview + execute.
 *
 * Player trade (swap): same purse math, 48h trade lock, auto-reject of conflicting TradeRequests.
 * No tradesUsed, no Sapphire/Gold/Emerald/Silver roster caps (commissioner bypass). Skips TradeRequest flow.
 */
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const Bid = require('../models/Bid');
const RetainedPlayer = require('../models/RetainedPlayer');
const TradeRequest = require('../models/TradeRequest');
const { invalidateCache } = require('../utils/cache');
const { reconcileUsersPurse } = require('../services/purseReconcileService');
const {
  isTradeLocked,
  setTradeLockOnPlayers,
  autoRejectTradesInvolvingPlayers,
  TRADE_LOCK_HOURS,
} = require('../utils/tradeApprovalShared');

const CRORE = 10_000_000;

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

// ---------- Teams & rosters ----------
router.get('/teams', async (req, res) => {
  try {
    await requireAdmin(req.query.adminUserId);
    const teams = await User.find({ isAdmin: { $ne: true }, isActive: { $ne: false } })
      .select('_id name teamName abbreviation purse isParticipating')
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

// ---------- Trade (commissioner only) ----------
// Intentionally NO tradesUsed, NO roster type caps here. Normal rules stay in routes/trades.js & routes/picks.js.
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
      User.findById(team1._id).select('teamName abbreviation purse'),
      User.findById(team2._id).select('teamName abbreviation purse'),
      Player.findById(player1Id),
      Player.findById(player2Id),
    ]);

    const v1 = Number(up1.bidValue || 0);
    const v2 = Number(up2.bidValue || 0);
    const p1 = purseNum(fullTeam1);
    const p2 = purseNum(fullTeam2);
    const newP1 = p1 + v1 - v2;
    const newP2 = p2 + v2 - v1;

    const pl1 = up1.playerId;
    const pl2 = up2.playerId;

    const errors = [];
    if (newP1 < 0) errors.push(`${team1.teamName || 'Team A'} purse would be negative (₹${toCr(newP1)} Cr)`);
    if (newP2 < 0) errors.push(`${team2.teamName || 'Team B'} purse would be negative (₹${toCr(newP2)} Cr)`);

    if ((await isTradeLocked(playerDoc1)) || (await isTradeLocked(playerDoc2))) {
      errors.push(
        `One or both players are trade-locked for ${TRADE_LOCK_HOURS}h after a completed trade or unsold pick (same as trade approval)`
      );
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

    const [lockP1, lockP2] = await Promise.all([Player.findById(player1Id), Player.findById(player2Id)]);
    if ((await isTradeLocked(lockP1)) || (await isTradeLocked(lockP2))) {
      return res.status(400).json({
        message: `Trade blocked: one or both players are trade-locked for ${TRADE_LOCK_HOURS}h after a completed trade or unsold pick.`,
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
      invalidateCache('players:data');
    } catch (_) {}

    const otherRequestsRejected = await autoRejectTradesInvolvingPlayers(
      adminUserId,
      [player1Id, player2Id],
      null,
    );

    res.json({
      ok: true,
      message: 'Trade completed (roster: no tradesUsed / no type caps)',
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

    const errors = [];
    if (after < 0) errors.push(`Insufficient purse: need ₹${toCr(basePrice)} Cr, have ₹${toCr(purse)} Cr`);

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

    await setTradeLockOnPlayers([playerId]);

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

    const playerDoc = await Player.findById(playerId).lean();
    if (!playerDoc) return res.status(404).json({ message: 'Player not found' });
    if (await isTradeLocked(playerDoc)) {
      return res.status(400).json({
        message: `Cannot release: player is trade-locked for ${TRADE_LOCK_HOURS} hours after a completed trade or unsold pick.`,
      });
    }

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

    const playerDoc = await Player.findById(playerId).lean();
    if (!playerDoc) return res.status(404).json({ message: 'Player not found' });
    if (await isTradeLocked(playerDoc)) {
      return res.status(400).json({
        message: `Cannot release: player is trade-locked for ${TRADE_LOCK_HOURS} hours after a completed trade or unsold pick.`,
      });
    }

    const bidValue = Number(up.bidValue || 0);
    up.isActive = false;
    up.updatedAt = new Date();
    await up.save();

    if (bidValue > 0) {
      await User.findByIdAndUpdate(teamUserId, { $inc: { purse: bidValue } });
    }

    const releaseBasePrice = bidValue > 0 ? bidValue : Number(playerDoc.basePrice || 0);

    await Player.findByIdAndUpdate(playerId, {
      $set: {
        isSold: false,
        isActive: false,
        basePrice: releaseBasePrice,
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

const ACTIVE_TRADE_STATUSES = ['pending', 'counter', 'admin_pending'];

function countByType(players) {
  const byType = { Sapphire: 0, Gold: 0, Emerald: 0, Silver: 0 };
  for (const p of players) {
    if (p?.type && Object.prototype.hasOwnProperty.call(byType, p.type)) byType[p.type] += 1;
  }
  return byType;
}

async function buildSquadSwapPreview(teamAId, teamBId) {
  const [teamA, teamB] = await Promise.all([
    User.findById(teamAId).select(
      'name teamName abbreviation purse boughtPlayers currentBids captainPlayerId isParticipating isAdmin',
    ),
    User.findById(teamBId).select(
      'name teamName abbreviation purse boughtPlayers currentBids captainPlayerId isParticipating isAdmin',
    ),
  ]);
  if (!teamA || !teamB) {
    const e = new Error('One or both teams not found');
    e.status = 404;
    throw e;
  }
  if (teamA.isAdmin || teamB.isAdmin) {
    const e = new Error('Cannot swap with an admin account');
    e.status = 400;
    throw e;
  }

  const [upsA, upsB, retainedA, retainedB] = await Promise.all([
    UserPlayer.find({ userId: teamAId, isActive: true }).populate('playerId', 'name type role').lean(),
    UserPlayer.find({ userId: teamBId, isActive: true }).populate('playerId', 'name type role').lean(),
    RetainedPlayer.find({ userId: teamAId, isActive: true }).select('playerName playerType').lean(),
    RetainedPlayer.find({ userId: teamBId, isActive: true }).select('playerName playerType').lean(),
  ]);

  const playerIdsA = upsA.map((u) => u.playerId?._id || u.playerId).filter(Boolean);
  const playerIdsB = upsB.map((u) => u.playerId?._id || u.playerId).filter(Boolean);
  const allPlayerIds = [...playerIdsA, ...playerIdsB];
  const overlapping = playerIdsA.map(String).filter((id) => new Set(playerIdsB.map(String)).has(id));

  const pendingTrades = await TradeRequest.find({
    status: { $in: ACTIVE_TRADE_STATUSES },
    $or: [
      ...(allPlayerIds.length
        ? [{ offeredPlayer: { $in: allPlayerIds } }, { requestedPlayer: { $in: allPlayerIds } }]
        : []),
      { fromUser: { $in: [teamAId, teamBId] } },
      { toUser: { $in: [teamAId, teamBId] } },
    ],
  })
    .select('_id status fromUser toUser')
    .lean();

  const spentA = upsA.reduce((s, u) => s + Number(u.bidValue || 0), 0);
  const spentB = upsB.reduce((s, u) => s + Number(u.bidValue || 0), 0);
  const locksA = (teamA.currentBids || []).reduce((s, b) => s + Number(b.amount || 0), 0);
  const locksB = (teamB.currentBids || []).reduce((s, b) => s + Number(b.amount || 0), 0);
  const purseA = purseNum(teamA);
  const purseB = purseNum(teamB);
  const BASELINE = 1_000_000_000;
  const expectedA = BASELINE - spentB - locksA;
  const expectedB = BASELINE - spentA - locksB;

  const playersA = upsA
    .filter((u) => u.playerId)
    .map((u) => ({
      id: u.playerId._id,
      name: u.playerId.name,
      type: u.playerId.type,
      bidValueCr: toCr(u.bidValue),
    }));
  const playersB = upsB
    .filter((u) => u.playerId)
    .map((u) => ({
      id: u.playerId._id,
      name: u.playerId.name,
      type: u.playerId.type,
      bidValueCr: toCr(u.bidValue),
    }));

  const errors = [];
  const warnings = [];
  if (String(teamAId) === String(teamBId)) errors.push('Pick two different teams');
  if (playersA.length === 0 && playersB.length === 0) errors.push('Both teams have empty rosters — nothing to swap');
  if (overlapping.length) errors.push('Data issue: both teams appear to own the same player(s)');
  if ((teamA.currentBids || []).length) {
    warnings.push(
      `${teamA.teamName || teamA.name} has ${teamA.currentBids.length} live bid lock(s) — those stay on this login, not the swapped squad`,
    );
  }
  if ((teamB.currentBids || []).length) {
    warnings.push(
      `${teamB.teamName || teamB.name} has ${teamB.currentBids.length} live bid lock(s) — those stay on this login, not the swapped squad`,
    );
  }
  if (pendingTrades.length) {
    warnings.push(`${pendingTrades.length} pending trade request(s) involving these teams/players will be rejected`);
  }
  if (teamA.isParticipating === false) warnings.push(`${teamA.teamName || teamA.name} is marked not participating`);
  if (teamB.isParticipating === false) warnings.push(`${teamB.teamName || teamB.name} is marked not participating`);

  const summarize = (team, players, retained, purseNow, purseAfter, spentInCr) => ({
    id: team._id,
    name: team.teamName,
    ownerName: team.name,
    abbreviation: team.abbreviation,
    participating: team.isParticipating !== false,
    playerCount: players.length,
    byType: countByType(players),
    spentCr: spentInCr,
    purseBeforeCr: toCr(purseNow),
    purseAfterCr: toCr(purseAfter),
    retained: retained.map((r) => r.playerName),
    players,
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pendingTradeCount: pendingTrades.length,
    teamA: summarize(teamA, playersA, retainedA, purseA, expectedA, toCr(spentA)),
    teamB: summarize(teamB, playersB, retainedB, purseB, expectedB, toCr(spentB)),
    teamAAfter: {
      playerCount: playersB.length,
      spentCr: toCr(spentB),
      retained: retainedB.map((r) => r.playerName),
    },
    teamBAfter: {
      playerCount: playersA.length,
      spentCr: toCr(spentA),
      retained: retainedA.map((r) => r.playerName),
    },
  };
}

router.post('/squad-swap/preview', async (req, res) => {
  try {
    const { adminUserId, teamAUserId, teamBUserId } = req.body;
    await requireAdmin(adminUserId);
    if (!teamAUserId || !teamBUserId) {
      return res.status(400).json({ message: 'teamAUserId and teamBUserId required' });
    }
    const preview = await buildSquadSwapPreview(teamAUserId, teamBUserId);
    res.json(preview);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

router.post('/squad-swap/execute', async (req, res) => {
  try {
    const { adminUserId, teamAUserId, teamBUserId } = req.body;
    await requireAdmin(adminUserId);
    if (!teamAUserId || !teamBUserId) {
      return res.status(400).json({ message: 'teamAUserId and teamBUserId required' });
    }
    if (String(teamAUserId) === String(teamBUserId)) {
      return res.status(400).json({ message: 'Pick two different teams' });
    }

    const preview = await buildSquadSwapPreview(teamAUserId, teamBUserId);
    if (!preview.ok) {
      return res.status(400).json({ message: preview.errors.join('; '), errors: preview.errors });
    }

    const [teamA, teamB] = await Promise.all([
      User.findById(teamAUserId),
      User.findById(teamBUserId),
    ]);
    if (!teamA || !teamB) return res.status(404).json({ message: 'Team not found' });

    const [upsA, upsB] = await Promise.all([
      UserPlayer.find({ userId: teamAUserId, isActive: true }).select('_id playerId').lean(),
      UserPlayer.find({ userId: teamBUserId, isActive: true }).select('_id playerId').lean(),
    ]);
    const upIdsA = upsA.map((u) => u._id);
    const upIdsB = upsB.map((u) => u._id);
    const playerIdsA = upsA.map((u) => u.playerId).filter(Boolean);
    const playerIdsB = upsB.map((u) => u.playerId).filter(Boolean);
    const allPlayerIds = [...playerIdsA, ...playerIdsB];

    const [retA, retB] = await Promise.all([
      RetainedPlayer.find({ userId: teamAUserId, isActive: true }).select('_id').lean(),
      RetainedPlayer.find({ userId: teamBUserId, isActive: true }).select('_id').lean(),
    ]);

    const now = new Date();
    const ops = [];
    if (upIdsA.length) {
      ops.push(
        UserPlayer.updateMany(
          { _id: { $in: upIdsA } },
          { $set: { userId: teamB._id, updatedAt: now } },
        ),
      );
    }
    if (upIdsB.length) {
      ops.push(
        UserPlayer.updateMany(
          { _id: { $in: upIdsB } },
          { $set: { userId: teamA._id, updatedAt: now } },
        ),
      );
    }
    if (retA.length) {
      ops.push(RetainedPlayer.updateMany({ _id: { $in: retA.map((r) => r._id) } }, { $set: { userId: teamB._id } }));
    }
    if (retB.length) {
      ops.push(RetainedPlayer.updateMany({ _id: { $in: retB.map((r) => r._id) } }, { $set: { userId: teamA._id } }));
    }
    if (playerIdsA.length) {
      ops.push(Player.updateMany({ _id: { $in: playerIdsA } }, { $set: { currentBidder: teamB._id } }));
    }
    if (playerIdsB.length) {
      ops.push(Player.updateMany({ _id: { $in: playerIdsB } }, { $set: { currentBidder: teamA._id } }));
    }
    await Promise.all(ops);

    const boughtA = [...(teamA.boughtPlayers || [])];
    const boughtB = [...(teamB.boughtPlayers || [])];
    teamA.boughtPlayers = boughtB;
    teamB.boughtPlayers = boughtA;

    const capA = teamA.captainPlayerId ? String(teamA.captainPlayerId) : null;
    const capB = teamB.captainPlayerId ? String(teamB.captainPlayerId) : null;
    const newAOwned = new Set(playerIdsB.map(String));
    const newBOwned = new Set(playerIdsA.map(String));
    if (capA && !newAOwned.has(capA)) teamA.captainPlayerId = null;
    if (capB && !newBOwned.has(capB)) teamB.captainPlayerId = null;
    await Promise.all([teamA.save(), teamB.save()]);

    let rejectedTrades = 0;
    if (allPlayerIds.length) {
      rejectedTrades += await autoRejectTradesInvolvingPlayers(
        adminUserId,
        allPlayerIds,
        null,
        'Auto-rejected: full squad transferred to another team',
      );
    }
    const leftoverTrades = await TradeRequest.find({
      status: { $in: ACTIVE_TRADE_STATUSES },
      $or: [{ fromUser: { $in: [teamAUserId, teamBUserId] } }, { toUser: { $in: [teamAUserId, teamBUserId] } }],
    });
    for (const t of leftoverTrades) {
      t.status = 'rejected';
      t.history.push({
        byUser: adminUserId,
        action: 'reject',
        message: 'Auto-rejected: full squad transferred to another team',
      });
      await t.save();
      rejectedTrades += 1;
    }

    const purseResult = await reconcileUsersPurse({
      userIds: [teamA._id, teamB._id],
      logTag: 'squad-swap',
    });

    try {
      invalidateCache('players:data');
      invalidateCache('user-purses');
    } catch (_) {}

    const [afterA, afterB] = await Promise.all([
      User.findById(teamAUserId).select('teamName purse').lean(),
      User.findById(teamBUserId).select('teamName purse').lean(),
    ]);

    res.json({
      ok: true,
      message: 'Squads swapped',
      teamA: {
        name: afterA.teamName,
        playerCount: preview.teamB.playerCount,
        purseAfterCr: toCr(purseNum(afterA)),
      },
      teamB: {
        name: afterB.teamName,
        playerCount: preview.teamA.playerCount,
        purseAfterCr: toCr(purseNum(afterB)),
      },
      pendingTradesRejected: rejectedTrades,
      purseReconcile: {
        updated: purseResult.updated,
        changes: purseResult.changes,
      },
    });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || 'Error' });
  }
});

module.exports = router;
