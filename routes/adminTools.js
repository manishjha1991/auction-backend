const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const RetainedPlayer = require('../models/RetainedPlayer');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const TradeRequest = require('../models/TradeRequest');
const {
  previewAuctionFixes,
  executeAuctionFixes,
} = require('../utils/auctionFixHelpers');
const {
  buildPurseUpdatePlan,
  executePursePlan,
  runPurseAutoFix,
} = require('../utils/purseAuditHelpers');
const { invalidateCache, clearAllCaches } = require('../utils/cache');

const AUCTION_RESET_COLLECTIONS = [
  'bidhistories',
  'bidnotifications',
  'bids',
  'comments',
  'fixtures',
  'notifications',
  'pickrequests',
  'playerstats',
  'playofffixtures',
  'postlikes',
  'releaserequests',
  'schedules',
  'traderequests',
  'useractivities',
];

const VALID_TYPES = ['Sapphire', 'Emerald', 'Gold', 'Silver'];

const toNumber = (value) => {
  if (!value) return 0;
  try {
    return Number(value);
  } catch {
    return 0;
  }
};

const requireAdmin = async (adminUserId) => {
  if (!adminUserId) {
    const error = new Error('Admin user ID is required');
    error.status = 400;
    throw error;
  }
  const admin = await User.findById(adminUserId).includeInactive().select('isAdmin name');
  if (!admin || !admin.isAdmin) {
    const err = new Error('Only admins can perform this action');
    err.status = 403;
    throw err;
  }
  return admin;
};

const normalizeType = (type) => {
  if (!type || typeof type !== 'string') return '';
  const lower = type.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const buildSyncPlan = async () => {
  const [users, userPlayers] = await Promise.all([
    User.find({})
      .select('_id name teamName boughtPlayers')
      .lean(),
    UserPlayer.find({ isActive: true })
      .select('userId playerId')
      .lean(),
  ]);

  const userPlayerMap = new Map();
  const playerIdSet = new Set();

  userPlayers.forEach((up) => {
    if (!up.userId || !up.playerId) return;
    const uid = up.userId.toString();
    const pid = up.playerId.toString();
    playerIdSet.add(pid);
    if (!userPlayerMap.has(uid)) {
      userPlayerMap.set(uid, []);
    }
    userPlayerMap.get(uid).push(pid);
  });

  const playerIds = Array.from(playerIdSet);
  const players = await Player.find({ _id: { $in: playerIds } })
    .select('_id name type isSold isActive')
    .lean();

  const playerMap = new Map(players.map((p) => [p._id.toString(), p]));

  const userPlans = [];
  let usersWithRecords = 0;
  let usersNeedingUpdates = 0;
  let totalPlayersToAdd = 0;

  users.forEach((user) => {
    const uid = user._id.toString();
    const ownedRecords = userPlayerMap.get(uid) || [];
    const boughtSet = new Set(
      (user.boughtPlayers || []).map((bp) => bp.toString())
    );

    if (ownedRecords.length > 0) {
      usersWithRecords += 1;
    }

    const missingPlayers = ownedRecords
      .filter((pid) => !boughtSet.has(pid))
      .map((pid) => {
        const info = playerMap.get(pid);
        return {
          playerId: pid,
          name: info?.name || 'Unknown Player',
          type: info?.type || 'N/A',
        };
      });

    if (missingPlayers.length > 0) {
      usersNeedingUpdates += 1;
      totalPlayersToAdd += missingPlayers.length;
    }

    userPlans.push({
      userId: uid,
      teamName: user.teamName || user.name || 'Unknown Team',
      userPlayerCount: ownedRecords.length,
      boughtPlayersCount: boughtSet.size,
      missingPlayers,
    });
  });

  const playerUpdates = players.map((player) => ({
    playerId: player._id.toString(),
    name: player.name,
    type: player.type,
    alreadySold: !!player.isSold,
    alreadyActive: !!player.isActive,
    needsStatusUpdate: !(player.isSold && player.isActive),
  }));

  return {
    summary: {
      totalUsers: users.length,
      usersWithUserPlayers: usersWithRecords,
      usersNeedingUpdates,
      totalUserPlayerRecords: userPlayers.length,
      totalPlayersToAdd,
    },
    users: userPlans,
    playerUpdates,
  };
};

const collectionExists = async (name) => {
  const cursor = mongoose.connection.db.listCollections({ name });
  return await cursor.hasNext();
};

const runAuctionReset = async () => {
  const retainedPlayers = await RetainedPlayer.find({
    isActive: true,
    status: { $in: ['approved', 'active'] },
  })
    .select('userId playerId')
    .lean();

  const retainedPlayerIds = retainedPlayers.map((rp) => rp.playerId);
  const retainedUserIds = retainedPlayers.map((rp) => rp.userId);
  const retainedPairs = retainedPlayers.map((rp) => ({
    userId: rp.userId,
    playerId: rp.playerId,
  }));

  await mongoose.connection.collection('users').updateMany(
    {},
    {
      $set: {
        fairnessPoint: 0,
        points: 0,
        matchesPlayed: 0,
        allPlayersReleased: false,
        isRetentionLocked: false,
        tradesUsed: 0,
        currentBids: [],
        currentBid: null,
        boughtPlayers: [],
      },
    }
  );

  if (retainedPlayerIds.length > 0) {
    const retainedByUser = retainedPlayers.reduce((acc, rp) => {
      const key = rp.userId.toString();
      if (!acc[key]) acc[key] = [];
      acc[key].push(rp.playerId);
      return acc;
    }, {});

    const userUpdates = Object.entries(retainedByUser).map(([userId, playerIds]) => {
      const retainedCount = playerIds.length;
      const purseValue = 1000000000 - retainedCount * 170000000;
      return {
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(userId) },
          update: { $set: { boughtPlayers: playerIds, purse: purseValue } },
        },
      };
    });

    if (userUpdates.length > 0) {
      await mongoose.connection.collection('users').bulkWrite(userUpdates);
    }
  }

  if (retainedPairs.length > 0) {
    await UserPlayer.deleteMany({ $nor: retainedPairs });
  } else {
    await UserPlayer.deleteMany({});
  }

  if (retainedPairs.length > 0) {
    const existingPairs = await UserPlayer.find({
      userId: { $in: retainedUserIds },
      playerId: { $in: retainedPlayerIds },
    })
      .select('userId playerId')
      .lean();

    const existingSet = new Set(
      existingPairs.map((p) => `${p.userId.toString()}-${p.playerId.toString()}`)
    );

    const missing = retainedPairs.filter(
      (rp) => !existingSet.has(`${rp.userId.toString()}-${rp.playerId.toString()}`)
    );

    if (missing.length > 0) {
      await UserPlayer.insertMany(
        missing.map((rp) => ({
          userId: rp.userId,
          playerId: rp.playerId,
          bidValue: 170000000,
          isActive: true,
        }))
      );
    }

    await UserPlayer.updateMany(
      { userId: { $in: retainedUserIds }, playerId: { $in: retainedPlayerIds } },
      { $set: { bidValue: 170000000, isActive: true } }
    );
  }

  if (retainedPlayerIds.length > 0) {
    await Player.updateMany(
      { _id: { $in: retainedPlayerIds } },
      { $set: { basePrice: 170000000, isSold: true, isActive: true } }
    );
  }

  const nonRetainedMatch = retainedPlayerIds.length > 0 ? { $nin: retainedPlayerIds } : { $exists: true };
  await Player.updateMany(
    { _id: nonRetainedMatch, type: 'Sapphire' },
    { $set: { basePrice: 20000000, isSold: false, isActive: false } }
  );
  await Player.updateMany(
    { _id: nonRetainedMatch, type: 'Emerald' },
    { $set: { basePrice: 15000000, isSold: false, isActive: false } }
  );
  await Player.updateMany(
    { _id: nonRetainedMatch, type: 'Gold' },
    { $set: { basePrice: 10000000, isSold: false, isActive: false } }
  );
  await Player.updateMany(
    { _id: nonRetainedMatch, type: 'Silver' },
    { $set: { basePrice: 1000000, isSold: false, isActive: false } }
  );

  const cleared = [];
  for (const name of AUCTION_RESET_COLLECTIONS) {
    const exists = await collectionExists(name);
    if (!exists) {
      cleared.push({ name, deletedCount: 0, skipped: true });
      continue;
    }
    const result = await mongoose.connection.collection(name).deleteMany({});
    cleared.push({ name, deletedCount: result.deletedCount || 0, skipped: false });
  }

  invalidateCache('user-purses');
  invalidateCache('players:data');
  invalidateCache('stats-overview');

  return {
    retained: {
      users: new Set(retainedUserIds.map((id) => id.toString())).size,
      players: retainedPlayerIds.length,
    },
    cleared,
  };
};

const { TRADE_SEASON_CAP: TRADE_CAP } = require('../utils/tradeConstants');

// POST: clear all backend caches (use after direct DB edits to see fresh data)
router.post('/clear-all-cache', async (req, res) => {
  try {
    const adminUserId = req.body.adminUserId || req.query.adminUserId;
    await requireAdmin(adminUserId);
    clearAllCaches();
    res.json({
      message: 'All caches cleared. Hard refresh the UI (Ctrl+Shift+R) to see fresh data.',
    });
  } catch (error) {
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to clear cache' });
  }
});

// GET: search teams by team name or player name (returns team IDs that match)
router.get('/team-trade-activity/search', async (req, res) => {
  try {
    const { adminUserId, q } = req.query;
    await requireAdmin(adminUserId);

    const query = (q || '').trim();
    if (!query || query.length < 2) {
      return res.json({ teamIds: [] });
    }

    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // 1. Teams matching by name
    const teamsByName = await User.find({
      isActive: true,
      isAdmin: false,
      $or: [
        { teamName: regex },
        { name: regex }
      ]
    }).select('_id').lean();

    const teamIdsByName = new Set(teamsByName.map((t) => t._id.toString()));

    // 2. Players matching by name
    const matchingPlayers = await Player.find({ name: regex }).select('_id').lean();
    const playerIds = matchingPlayers.map((p) => p._id);

    if (playerIds.length === 0 && teamIdsByName.size === 0) {
      return res.json({ teamIds: Array.from(teamIdsByName) });
    }

    // 3. User IDs from releases, picks, trades involving these players
    const [releaseUsers, pickUsers, tradeFromUsers, tradeToUsers] = await Promise.all([
      playerIds.length > 0
        ? ReleaseRequest.find({ player: { $in: playerIds }, status: 'completed' }).distinct('user')
        : [],
      playerIds.length > 0
        ? PickRequest.find({ player: { $in: playerIds }, status: 'completed' }).distinct('user')
        : [],
      playerIds.length > 0
        ? TradeRequest.find({
            status: 'completed',
            $or: [
              { offeredPlayer: { $in: playerIds } },
              { requestedPlayer: { $in: playerIds } }
            ]
          }).distinct('fromUser')
        : [],
      playerIds.length > 0
        ? TradeRequest.find({
            status: 'completed',
            $or: [
              { offeredPlayer: { $in: playerIds } },
              { requestedPlayer: { $in: playerIds } }
            ]
          }).distinct('toUser')
        : []
    ]);

    const allUserIds = [...releaseUsers, ...pickUsers, ...tradeFromUsers, ...tradeToUsers];
    allUserIds.forEach((id) => teamIdsByName.add(id.toString()));

    res.json({ teamIds: Array.from(teamIdsByName) });
  } catch (error) {
    console.error('team-trade-activity search error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to search' });
  }
});

// GET: team trade activity (picks, releases, trades by team; used/remaining)
router.get('/team-trade-activity', async (req, res) => {
  try {
    const { adminUserId } = req.query;
    await requireAdmin(adminUserId);

    const teams = await User.find({ isActive: true, isAdmin: false })
      .select('_id name teamName tradesUsed')
      .sort({ teamName: 1 })
      .lean();

    const teamIds = teams.map((t) => t._id);

    const [releaseCounts, pickCounts, tradeAsFrom, tradeAsTo] = await Promise.all([
      ReleaseRequest.aggregate([
        { $match: { user: { $in: teamIds }, status: 'completed' } },
        { $group: { _id: '$user', count: { $sum: 1 } } }
      ]),
      PickRequest.aggregate([
        { $match: { user: { $in: teamIds }, status: 'completed' } },
        { $group: { _id: '$user', count: { $sum: 1 } } }
      ]),
      TradeRequest.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$fromUser', count: { $sum: 1 } } }
      ]),
      TradeRequest.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$toUser', count: { $sum: 1 } } }
      ])
    ]);

    const releaseMap = new Map(releaseCounts.map((r) => [r._id.toString(), r.count]));
    const pickMap = new Map(pickCounts.map((p) => [p._id.toString(), p.count]));
    const tradeMap = new Map();
    [...tradeAsFrom, ...tradeAsTo].forEach(({ _id, count }) => {
      const uid = _id.toString();
      tradeMap.set(uid, (tradeMap.get(uid) || 0) + count);
    });

    const result = teams.map((team) => {
      const uid = team._id.toString();
      const releases = releaseMap.get(uid) || 0;
      const picks = pickMap.get(uid) || 0;
      const trades = tradeMap.get(uid) || 0;
      const tradesUsed = Number(team.tradesUsed || 0);
      const remaining = Math.max(0, TRADE_CAP - tradesUsed);
      return {
        userId: uid,
        teamName: team.teamName || team.name || 'Unknown',
        name: team.name,
        picks,
        releases,
        trades,
        tradesUsed,
        remaining,
        cap: TRADE_CAP
      };
    });

    res.json({ teams: result });
  } catch (error) {
    console.error('team-trade-activity error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to load team trade activity' });
  }
});

// GET: team trade activity details (players involved in picks, releases, trades)
router.get('/team-trade-activity/:userId/details', async (req, res) => {
  try {
    const { userId } = req.params;
    const { adminUserId } = req.query;
    await requireAdmin(adminUserId);

    const uid = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : null;
    if (!uid) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }

    const [releases, picks, tradesAsFrom, tradesAsTo] = await Promise.all([
      ReleaseRequest.find({ user: uid, status: 'completed' })
        .populate('player', 'name type role')
        .sort({ updatedAt: -1 })
        .lean(),
      PickRequest.find({ user: uid, status: 'completed' })
        .populate('player', 'name type role')
        .sort({ updatedAt: -1 })
        .lean(),
      TradeRequest.find({ fromUser: uid, status: 'completed' })
        .populate('offeredPlayer', 'name type role')
        .populate('requestedPlayer', 'name type role')
        .populate('toUser', 'teamName name')
        .sort({ updatedAt: -1 })
        .lean(),
      TradeRequest.find({ toUser: uid, status: 'completed' })
        .populate('offeredPlayer', 'name type role')
        .populate('requestedPlayer', 'name type role')
        .populate('fromUser', 'teamName name')
        .sort({ updatedAt: -1 })
        .lean()
    ]);

    const trades = [
      ...tradesAsFrom.map((t) => ({ ...t, direction: 'out', otherTeam: t.toUser?.teamName || t.toUser?.name })),
      ...tradesAsTo.map((t) => ({ ...t, direction: 'in', otherTeam: t.fromUser?.teamName || t.fromUser?.name }))
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json({
      releases: releases.map((r) => ({ player: r.player, date: r.updatedAt })),
      picks: picks.map((p) => ({ player: p.player, date: p.updatedAt })),
      trades: trades.map((t) => ({
        offeredPlayer: t.offeredPlayer,
        requestedPlayer: t.requestedPlayer,
        direction: t.direction,
        otherTeam: t.otherTeam,
        date: t.updatedAt
      }))
    });
  } catch (error) {
    console.error('team-trade-activity details error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to load team trade details' });
  }
});

router.get('/player-type/status', async (req, res) => {
  try {
    const { adminUserId } = req.query;
    await requireAdmin(adminUserId);
    const stats = await Promise.all(
      VALID_TYPES.map(async (type) => {
        const [totalUnsold, activeUnsold] = await Promise.all([
          Player.countDocuments({ type, isSold: false }),
          Player.countDocuments({ type, isSold: false, isActive: true }),
        ]);
        return {
          type,
          totalUnsold,
          activeUnsold,
          inactiveUnsold: Math.max(totalUnsold - activeUnsold, 0),
          isEnabled: totalUnsold === 0 ? true : activeUnsold === totalUnsold,
        };
      })
    );
    res.json({ types: stats });
  } catch (error) {
    console.error('player-type/status error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to load player type status' });
  }
});

router.post('/player-type/toggle', async (req, res) => {
  try {
    const { adminUserId, type, enable } = req.body;
    await requireAdmin(adminUserId);
    const normalizedType = normalizeType(type);
    if (!VALID_TYPES.includes(normalizedType)) {
      return res.status(400).json({ message: 'Invalid player type' });
    }
    if (typeof enable !== 'boolean') {
      return res.status(400).json({ message: 'Enable flag is required' });
    }
    const result = await Player.updateMany(
      { type: normalizedType, isSold: false },
      { $set: { isActive: enable } }
    );
    res.json({
      message: `Set ${normalizedType} players to ${enable ? 'active' : 'inactive'}`,
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error('player-type/toggle error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to toggle player type' });
  }
});

router.post('/auction/reset', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    await requireAdmin(adminUserId);
    const result = await runAuctionReset();
    res.json({
      message: 'Auction reset completed',
      ...result,
    });
  } catch (error) {
    console.error('auction/reset error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to reset auction' });
  }
});

router.post('/scripts/purse/preview', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    await requireAdmin(adminUserId);
    const plan = await buildPurseUpdatePlan();
    res.json(plan);
  } catch (error) {
    console.error('purse preview error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to build purse preview' });
  }
});

router.post('/scripts/purse/execute', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    await requireAdmin(adminUserId);
    const plan = await buildPurseUpdatePlan();
    const result = await executePursePlan(plan);
    res.json(result);
  } catch (error) {
    console.error('purse execute error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to execute purse update' });
  }
});

router.post('/scripts/sync/preview', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    await requireAdmin(adminUserId);
    const plan = await buildSyncPlan();
    res.json(plan);
  } catch (error) {
    console.error('sync preview error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to build sync preview' });
  }
});

router.post('/scripts/sync/execute', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    await requireAdmin(adminUserId);
    const plan = await buildSyncPlan();

    const userOps = plan.users
      .filter((user) => user.missingPlayers.length > 0)
      .map((user) => ({
        updateOne: {
          filter: { _id: user.userId },
          update: {
            $addToSet: {
              boughtPlayers: {
                $each: user.missingPlayers.map((p) =>
                  new mongoose.Types.ObjectId(p.playerId)
                ),
              },
            },
          },
        },
      }));

    const playerIdsToUpdate = plan.playerUpdates
      .filter((player) => player.needsStatusUpdate)
      .map((player) => new mongoose.Types.ObjectId(player.playerId));

    let userBulkResult = null;
    if (userOps.length > 0) {
      userBulkResult = await User.bulkWrite(userOps);
    }

    let playerResult = null;
    if (playerIdsToUpdate.length > 0) {
      playerResult = await Player.updateMany(
        { _id: { $in: playerIdsToUpdate } },
        { $set: { isSold: true, isActive: true } }
      );
    }

    res.json({
      summary: plan.summary,
      usersUpdated: userBulkResult ? userBulkResult.modifiedCount : 0,
      playersUpdated: playerResult ? playerResult.modifiedCount : 0,
    });
  } catch (error) {
    console.error('sync execute error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to execute sync routine' });
  }
});

router.post('/scripts/auction-fix/preview', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    await requireAdmin(adminUserId);
    const plan = await previewAuctionFixes();
    res.json(plan);
  } catch (error) {
    console.error('auction-fix preview error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to build auction fix preview' });
  }
});

router.post('/scripts/auction-fix/execute', async (req, res) => {
  try {
    const { adminUserId, playerIds } = req.body;
    await requireAdmin(adminUserId);
    const result = await executeAuctionFixes({ playerIds });
    res.json(result);
  } catch (error) {
    console.error('auction-fix execute error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to execute auction fix' });
  }
});

router.post('/users/:userId/active', async (req, res) => {
  try {
    const { adminUserId, isActive } = req.body;
    const { userId } = req.params;
    await requireAdmin(adminUserId);
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive boolean required' });
    }
    const user = await User.findByIdAndUpdate(
      userId,
      { isActive },
      { new: true, runValidators: true }
    )
      .includeInactive()
      .select('_id name teamName isActive isAdmin');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      message: user.isActive ? 'User activated' : 'User deactivated',
      user,
    });
  } catch (error) {
    console.error('user active toggle error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to update user status' });
  }
});

// Target Calculator based on CPL METHOD (DLS) for network or game glitch disconnected matches
// POST: Calculate target based on CPL DLS method (available to all users)
router.post('/target/calculate', async (req, res) => {
  try {
    const { userId, matchData } = req.body;
    
    // Optional: validate user exists (but don't require admin)
    if (userId) {
      try {
        const user = await User.findById(userId).select('_id name');
        if (!user) {
          return res.status(400).json({ message: 'User not found' });
        }
      } catch (userError) {
        // Continue even if user validation fails - allow public access
        console.warn('User validation failed, continuing:', userError);
      }
    }

    const {
      team1Score,
      team1Wickets,
      team1Overs,
      team2OversAvailable, // Overs available for team 2 (e.g., 20 overs)
      onStrikePower, // Power rating of player on strike
      nonStrikePower, // Power rating of player on non-strike
      nextPlayersPower // Array of power ratings for next players
    } = matchData;

    // Validate inputs
    if (!team1Score || team1Overs === undefined || !team2OversAvailable) {
      return res.status(400).json({ 
        message: 'Missing required fields: team1Score, team1Overs, team2OversAvailable' 
      });
    }

    // Parse scores and overs
    const parseRuns = (score) => {
      if (typeof score === 'number') return score;
      if (typeof score === 'string') {
        const match = score.match(/(\d+)/);
        return match ? parseInt(match[1]) : 0;
      }
      return 0;
    };

    const parseOvers = (overs) => {
      if (typeof overs === 'number') return overs;
      if (typeof overs === 'string') {
        const parts = overs.split('.');
        const fullOvers = parseInt(parts[0]) || 0;
        const balls = parseInt(parts[1]) || 0;
        return fullOvers + (balls / 6);
      }
      return 0;
    };

    const runsScored = parseRuns(team1Score);
    const oversFaced = parseOvers(team1Overs);
    const wicketsLost = parseInt(team1Wickets) || 0;
    const oversAvailable = parseFloat(team2OversAvailable);
    const remainingOvers = oversAvailable - oversFaced;

    // CPL METHOD can only be applied if match is disconnected after more than 10 overs
    // Must be MORE than 10 overs (not equal to 10)
    if (oversFaced <= 10) {
      return res.status(400).json({ 
        message: 'CPL METHOD (DLS) can only be applied if match is disconnected after more than 10 overs of first innings. Current overs: ' + oversFaced 
      });
    }

    if (oversFaced === 0) {
      return res.status(400).json({ message: 'Team 1 overs cannot be zero' });
    }

    if (remainingOvers <= 0) {
      return res.status(400).json({ message: 'Team 2 overs available must be greater than Team 1 overs faced' });
    }

    // Get all remaining players (including on-strike and non-strike)
    const onStrike = parseInt(onStrikePower) || 60;
    const nonStrike = parseInt(nonStrikePower) || 60;
    const nextPlayers = Array.isArray(nextPlayersPower) ? nextPlayersPower : [];
    
    // All remaining players to bat (including current players at crease) - for power bonus calculation
    const allRemainingPlayers = [onStrike, nonStrike, ...nextPlayers];
    
    // IMPORTANT: RPO is based on: on-strike, non-strike, OR batsmen left to bat
    // Check if ANY of: on-strike, non-strike, OR batsmen left to bat has 70+ power (70 is included)
    const has70PlusOnStrike = parseInt(onStrike) >= 70;
    const has70PlusNonStrike = parseInt(nonStrike) >= 70;
    const has70PlusBatsmanLeft = nextPlayers.some(power => parseInt(power) >= 70);
    
    // If ANY of these has 70+ power → 6 runs per over
    // If NONE has 70+ power (all < 70) → 3 runs per over
    const has70PlusAnywhere = has70PlusOnStrike || has70PlusNonStrike || has70PlusBatsmanLeft;
    const runsPerOver = has70PlusAnywhere ? 6 : 3;
    
    // Calculate runs from remaining overs
    const remainingOversRuns = remainingOvers * runsPerOver;
    
    // Calculate power bonus for each remaining player (including players at crease)
    let totalPowerBonus = 0;
    const powerAnalysis = [];
    
    allRemainingPlayers.forEach((power, index) => {
      const playerPower = parseInt(power) || 60;
      let bonus = 0;
      let playerLabel = '';
      
      if (index === 0) {
        playerLabel = 'On Strike';
      } else if (index === 1) {
        playerLabel = 'Non-Strike';
      } else {
        playerLabel = `Next ${index - 1}`;
      }
      
      // Power bonus calculation
      // 60-69 power players & any bowler = 2 runs
      if (playerPower >= 80) {
        bonus = 10; // 80+ Power: 10 runs
      } else if (playerPower >= 70) {
        bonus = 6; // 70-79 Power: 6 runs
      } else if (playerPower >= 60 && playerPower < 70) {
        bonus = 2; // 60-69 Power: 2 runs (bowlers)
      } else {
        bonus = 2; // Below 60: 2 runs
      }
      
      totalPowerBonus += bonus;
      powerAnalysis.push({
        player: playerLabel,
        power: playerPower,
        bonus: bonus,
        originalPower: playerPower
      });
    });
    
    // Final target calculation
    // Total = Current score + Remaining overs runs + Power bonus
    const projectedTotal = runsScored + remainingOversRuns + totalPowerBonus;
    const target = projectedTotal + 1; // +1 to win
    
    // Calculate required run rate
    const requiredRunRate = target / oversAvailable;
    
    // Build calculation details
    const calculationDetails = `CPL METHOD: ${remainingOvers} overs × ${runsPerOver} RPO = ${remainingOversRuns} runs. Power bonus: ${totalPowerBonus} runs.`;

    res.json({
      success: true,
      calculation: {
        team1Score: runsScored,
        team1Overs: oversFaced,
        team1Wickets: wicketsLost,
        team2OversAvailable: oversAvailable,
        remainingOvers: parseFloat(remainingOvers.toFixed(1)),
        runsPerOver: runsPerOver,
        remainingOversRuns: remainingOversRuns,
        totalPowerBonus: totalPowerBonus,
        projectedTotal: projectedTotal,
        target,
        requiredRunRate: parseFloat(requiredRunRate.toFixed(2)),
        has70PlusAnywhere: has70PlusAnywhere,
        has70PlusOnStrike: has70PlusOnStrike,
        has70PlusNonStrike: has70PlusNonStrike,
        has70PlusBatsmanLeft: has70PlusBatsmanLeft,
        powerAnalysis,
        calculationDetails
      }
    });
  } catch (error) {
    console.error('Target calculation error', error);
    res
      .status(error.status || 500)
      .json({ message: error.message || 'Failed to calculate target' });
  }
});

// Helper function to normalize power rating
function normalizePower(power) {
  const powerNum = parseInt(power) || 60;
  if (powerNum < 70) {
    return 60; // Anything below 70 → 60 (bowler)
  } else if (powerNum < 80) {
    return 78; // Anything below 80 (but >= 70) → 78
  } else {
    return powerNum; // 80+ → keep as is
  }
}

// Helper function to calculate expected runs from a player based on power rating
function calculatePlayerRuns(power, overs, groundSize, isOnStrike, allPlayersSamePower = false) {
  // Normalize power rating
  const normalizedPower = normalizePower(power);
  
  // Base runs per over based on normalized power rating
  let baseRunsPerOver = 5; // Default for 60 power
  
  if (normalizedPower >= 80) {
    baseRunsPerOver = isOnStrike ? 11 : 10; // On-strike gets slightly more
  } else if (normalizedPower === 78) {
    baseRunsPerOver = isOnStrike ? 9 : 8;
  } else {
    // 60 power (bowlers)
    baseRunsPerOver = isOnStrike ? 4 : 3;
  }

  // If all players have the same power, adjust for realism
  // When all bowlers (60) → they struggle more, reduce runs
  // When all 78 → moderate performance
  // When all 80+ → excellent performance, but not unrealistic
  if (allPlayersSamePower) {
    if (normalizedPower === 60) {
      // All bowlers - they really struggle, reduce by 20%
      baseRunsPerOver *= 0.8;
    } else if (normalizedPower === 78) {
      // All 78 - consistent moderate performance, slight boost
      baseRunsPerOver *= 1.05;
    } else if (normalizedPower >= 80) {
      // All 80+ - excellent but realistic, slight reduction to avoid unrealistic scores
      baseRunsPerOver *= 0.95;
    }
  }

  // Ground size adjustment
  let groundAdjustment = 1.0;
  if (groundSize === 'small') {
    groundAdjustment = 1.15; // Small ground = easier boundaries
  } else if (groundSize === 'big') {
    groundAdjustment = 0.85; // Big ground = harder boundaries
  }

  // Calculate total runs
  const totalRuns = baseRunsPerOver * overs * groundAdjustment;
  
  return totalRuns;
}

module.exports = router;

