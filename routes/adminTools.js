const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
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

// Target Calculator based on CPL METHOD (DLS) for rain-affected matches
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

    // CPL METHOD can only be applied if match is disconnected after 10 overs
    if (oversFaced < 10) {
      return res.status(400).json({ 
        message: 'CPL METHOD (DLS) can only be applied if match is disconnected after 10 overs of first innings' 
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
    
    // All remaining players to bat (including current players at crease)
    const allRemainingPlayers = [onStrike, nonStrike, ...nextPlayers];
    
    // Check if ANY remaining player (batsman/allrounder) has 70+ power
    const has70PlusPlayer = allRemainingPlayers.some(power => parseInt(power) >= 70);
    
    // Determine runs per over based on remaining players
    // If ANY player has 70+ power → 6 runs per over
    // If NO player has 70+ power (all < 70) → 3 runs per over
    const runsPerOver = has70PlusPlayer ? 6 : 3;
    
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
      if (playerPower >= 80) {
        bonus = 10; // 80+ Power: 10 runs
      } else if (playerPower >= 70) {
        bonus = 6; // 70-79 Power: 6 runs
      } else if (playerPower >= 60) {
        bonus = 4; // 60-69 Power: 4 runs
      } else {
        bonus = 2; // Below 60 & Bowlers: 2 runs
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
        has70PlusPlayer: has70PlusPlayer,
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

