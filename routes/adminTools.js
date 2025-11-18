const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');

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
  const admin = await User.findById(adminUserId).select('isAdmin name');
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

const buildPurseUpdatePlan = async () => {
  const [users, userPlayers] = await Promise.all([
    User.find({ isAdmin: { $ne: true } })
      .select('_id name teamName purse')
      .lean(),
    UserPlayer.find({ isActive: true })
      .select('userId bidValue')
      .lean(),
  ]);

  const userPlayerMap = new Map();
  userPlayers.forEach((up) => {
    if (!up.userId) return;
    const key = up.userId.toString();
    if (!userPlayerMap.has(key)) {
      userPlayerMap.set(key, []);
    }
    userPlayerMap.get(key).push(up);
  });

  const updates = [];
  let totalUsers = 0;
  let usersToUpdate = 0;

  users.forEach((user) => {
    const userId = user._id.toString();
    const associatedPlayers = userPlayerMap.get(userId) || [];
    const totalPlayerValue = associatedPlayers.reduce(
      (sum, up) => sum + (Number(up.bidValue) || 0),
      0
    );

    const currentPurseValue = toNumber(user.purse);
    const currentPurseCr = currentPurseValue / 10000000;
    const playersValueCr = totalPlayerValue / 10000000;
    const newPurseCr = 100 - playersValueCr;
    const differenceCr = newPurseCr - currentPurseCr;
    const newPurseValue = Math.max(newPurseCr, 0) * 10000000;

    updates.push({
      userId,
      teamName: user.teamName || user.name || 'Unknown',
      currentPurseCr,
      playersValueCr,
      newPurseCr,
      differenceCr,
      currentPurseValue,
      newPurseValue,
    });

    if (Math.abs(differenceCr) > 0.01) {
      usersToUpdate += 1;
    }
    totalUsers += 1;
  });

  return {
    summary: {
      totalUsers,
      usersToUpdate,
      usersUnchanged: totalUsers - usersToUpdate,
    },
    updates,
  };
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
    let updatedCount = 0;
    const failures = [];

    for (const op of plan.updates) {
      if (Math.abs(op.differenceCr) <= 0.01) continue;
      try {
        await User.findByIdAndUpdate(op.userId, {
          purse: mongoose.Types.Decimal128.fromString(
            op.newPurseValue.toString()
          ),
        });
        updatedCount += 1;
      } catch (err) {
        failures.push({
          teamName: op.teamName,
          error: err.message,
        });
      }
    }

    res.json({
      summary: plan.summary,
      updatedCount,
      failures,
    });
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

module.exports = router;

