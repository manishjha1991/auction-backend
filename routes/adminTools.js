const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const UserActivity = require('../models/UserActivity');
const {
  previewAuctionFixes,
  executeAuctionFixes,
} = require('../utils/auctionFixHelpers');
const {
  buildPurseUpdatePlan,
  executePursePlan,
  runPurseAutoFix,
} = require('../utils/purseAuditHelpers');

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

// Get all user activity with filters
router.get('/user-activity', async (req, res) => {
  try {
    const { adminUserId, userId, action, isSuspicious, limit = 100, skip = 0 } = req.query;
    await requireAdmin(adminUserId);

    const filter = {};
    if (userId) filter.userId = userId;
    if (action) filter.action = action;
    if (isSuspicious === 'true') filter.isSuspicious = true;

    const activities = await UserActivity.find(filter)
      .populate('userId', 'name email teamName')
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .lean();

    const total = await UserActivity.countDocuments(filter);

    res.json({ activities, total });
  } catch (error) {
    console.error('Error fetching user activity:', error);
    res.status(error.status || 500).json({ message: error.message || 'Failed to fetch user activity' });
  }
});

// Get suspicious activity summary
router.get('/suspicious-activity', async (req, res) => {
  try {
    const { adminUserId } = req.query;
    await requireAdmin(adminUserId);

    // Get users with suspicious activity
    const suspiciousUsers = await User.find({ 
      suspiciousActivityCount: { $gt: 0 },
      isAdmin: false // Exclude admins from suspicious users list
    })
      .select('name email teamName lastLoginIP lastBidIP suspiciousActivityCount lastLoginTime lastBidTime lastDeviceFingerprint')
      .sort({ suspiciousActivityCount: -1 })
      .lean();

    // Get recent suspicious activities
    const recentSuspicious = await UserActivity.find({ isSuspicious: true })
      .populate('userId', 'name email teamName isAdmin')
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    // Get IP address statistics (grouped by IP showing which users are using same IP)
    const ipStats = await UserActivity.aggregate([
      { $match: { isSuspicious: true } },
      { $group: { _id: '$ipAddress', count: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);

    // Get users with IP mismatches
    const ipMismatchUsers = await User.find({
      $and: [
        { lastLoginIP: { $exists: true, $ne: null } },
        { lastBidIP: { $exists: true, $ne: null } },
        { $expr: { $ne: ['$lastLoginIP', '$lastBidIP'] } },
        { isAdmin: false } // Exclude admins
      ]
    })
      .select('name email teamName lastLoginIP lastBidIP suspiciousActivityCount')
      .lean();

    // Get multi-account usage (same IP/device used by multiple accounts)
    const multiAccountUsage = await UserActivity.aggregate([
      { 
        $match: { 
          isSuspicious: true,
          'details.otherAccountsSameDevice': { $exists: true, $ne: [] }
        }
      },
      { $sort: { timestamp: -1 } },
      { $limit: 30 },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $match: { 'user.isAdmin': false } } // Exclude admin accounts
    ]);

    // Get new device login alerts
    const newDeviceLogins = await UserActivity.aggregate([
      {
        $match: {
          isSuspicious: true,
          'details.newDevice': true
        }
      },
      { $sort: { timestamp: -1 } },
      { $limit: 30 },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $match: { 'user.isAdmin': false } }
    ]);

    res.json({
      suspiciousUsers,
      recentSuspicious,
      ipStats,
      ipMismatchUsers,
      multiAccountUsage,
      newDeviceLogins,
      summary: {
        totalSuspiciousUsers: suspiciousUsers.length,
        totalSuspiciousActivities: recentSuspicious.length,
        totalIPMismatches: ipMismatchUsers.length,
        totalMultiAccountCases: multiAccountUsage.length,
        totalNewDeviceAlerts: newDeviceLogins.length
      }
    });
  } catch (error) {
    console.error('Error fetching suspicious activity:', error);
    res.status(error.status || 500).json({ message: error.message || 'Failed to fetch suspicious activity' });
  }
});

// Get user activity for a specific user
router.get('/user-activity/:userId', async (req, res) => {
  try {
    const { adminUserId } = req.query;
    const { userId } = req.params;
    await requireAdmin(adminUserId);

    const activities = await UserActivity.find({ userId })
      .sort({ timestamp: -1 })
      .limit(200)
      .lean();

    const user = await User.findById(userId).select('name email teamName lastLoginIP lastBidIP suspiciousActivityCount lastLoginTime lastBidTime').lean();

    res.json({ user, activities });
  } catch (error) {
    console.error('Error fetching user activity:', error);
    res.status(error.status || 500).json({ message: error.message || 'Failed to fetch user activity' });
  }
});

module.exports = router;

