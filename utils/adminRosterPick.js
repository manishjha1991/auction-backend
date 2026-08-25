const mongoose = require('mongoose');
const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const Bid = require('../models/Bid');
const PickRequest = require('../models/PickRequest');
const { setTradeLockOnPlayers } = require('./tradeApprovalShared');

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

function idStr(id) {
  return id == null ? '' : String(id);
}

function sameId(a, b) {
  return idStr(a) === idStr(b);
}

function purseNum(doc) {
  if (!doc?.purse) return 0;
  return parseFloat(doc.purse.toString());
}

function findLock(currentBids, playerId) {
  return (currentBids || []).find((cb) => sameId(cb.playerId, playerId)) || null;
}

/**
 * Net purse change after refunding every currentBids lock for this player,
 * then charging the destination team `basePrice` once.
 *
 * Same-team pending pick: refund the locked base then charge base → net 0 extra.
 * Other-team pending pick: that team is refunded; destination is charged once.
 */
function planCommissionerPickPurse({ basePrice, targetUserId, locks }) {
  const charge = Number(basePrice) || 0;
  const refunds = (locks || []).map((lock) => ({
    userId: idStr(lock.userId),
    amount: Number(lock.amount) || 0,
  }));
  const netByUser = {};
  for (const refund of refunds) {
    netByUser[refund.userId] = (netByUser[refund.userId] || 0) + refund.amount;
  }
  const tid = idStr(targetUserId);
  netByUser[tid] = (netByUser[tid] || 0) - charge;
  return { refunds, charge, netByUser };
}

function applyLockRefundToUser(user, playerId) {
  const cb = findLock(user.currentBids, playerId);
  if (!cb) {
    return { refunded: 0 };
  }
  const refunded = Number(cb.amount) || 0;
  if (refunded > 0) {
    const purse = purseNum(user);
    user.purse = mongoose.Types.Decimal128.fromString(String(purse + refunded));
  }
  user.currentBids = (user.currentBids || []).filter((c) => !sameId(c.playerId, playerId));
  return { refunded };
}

async function refundOtherTeamsCurrentBidLocks(playerId, excludeUserId) {
  const users = await User.find({ 'currentBids.playerId': playerId }).includeInactive();
  for (const user of users) {
    if (sameId(user._id, excludeUserId)) continue;
    applyLockRefundToUser(user, playerId);
    await user.save();
  }
}

async function cancelPendingPicksForPlayer(playerId, adminUserId) {
  await PickRequest.updateMany(
    { player: playerId, status: { $in: ['pending', 'admin_pending'] } },
    {
      $set: {
        status: 'rejected',
        adminDecision: {
          status: 'rejected',
          decidedBy: adminUserId,
          decidedAt: new Date(),
          note: 'Cancelled: player assigned via commissioner pick',
        },
      },
    }
  );
}

async function rollbackClaim(playerId, createdUserPlayerId) {
  if (createdUserPlayerId) {
    await UserPlayer.deleteOne({ _id: createdUserPlayerId });
  }
  await Player.findByIdAndUpdate(playerId, {
    $set: {
      isSold: false,
      isActive: false,
      currentBid: null,
      currentBidder: null,
    },
  });
}

/**
 * Commissioner unsold pick. Claims the player before touching purse so a
 * pending pick (or concurrent execute) cannot double-charge or dual-assign.
 */
async function executeCommissionerPick({ adminUserId, teamUserId, playerId }) {
  const existing = await UserPlayer.findOne({ playerId, isActive: true });
  if (existing) {
    return { ok: false, status: 400, message: 'Player already assigned to a team' };
  }

  const [user, player] = await Promise.all([
    User.findById(teamUserId),
    Player.findById(playerId),
  ]);
  if (!user || !player) {
    return { ok: false, status: 404, message: 'Team or player not found' };
  }
  if (player.isSold) {
    return { ok: false, status: 400, message: 'Player already sold' };
  }
  // Unsold pick pool is isSold:false AND isActive:false (preview). Live lots must not be yanked.
  if (player.isActive) {
    return {
      ok: false,
      status: 400,
      message: 'Player is in the live auction pool and cannot be picked here',
    };
  }

  const fortyEightHoursAgo = new Date(Date.now() - FORTY_EIGHT_HOURS_MS);
  if (player.releasedAt && new Date(player.releasedAt) > fortyEightHoursAgo) {
    return { ok: false, status: 400, message: 'Player was released in the last 48h — pick blocked' };
  }

  const basePrice = Number(player.basePrice || 0);
  const existingLock = findLock(user.currentBids, playerId);
  const lockedAmount = existingLock ? Number(existingLock.amount) || 0 : 0;
  const purse = purseNum(user);
  if (purse + lockedAmount < basePrice) {
    return { ok: false, status: 400, message: 'Insufficient purse' };
  }

  const claimed = await Player.findOneAndUpdate(
    { _id: playerId, isSold: { $ne: true } },
    {
      $set: {
        isSold: true,
        isActive: true,
        currentBid: basePrice,
        currentBidder: user._id,
        updatedAt: new Date(),
      },
    },
    { new: true }
  );
  if (!claimed) {
    return { ok: false, status: 400, message: 'Player already sold' };
  }

  let createdUserPlayerId = null;
  let chargedTarget = false;
  try {
    const up = await UserPlayer.create({
      playerId,
      userId: teamUserId,
      bidValue: basePrice,
      isActive: true,
    });
    createdUserPlayerId = up._id;

    await refundOtherTeamsCurrentBidLocks(playerId, teamUserId);
    await cancelPendingPicksForPlayer(playerId, adminUserId);
    await Bid.deleteMany({ playerId });

    const fresh = await User.findById(teamUserId);
    if (!fresh) {
      throw new Error('Team not found after claim');
    }
    applyLockRefundToUser(fresh, playerId);
    const purseAfterRefund = purseNum(fresh);
    if (purseAfterRefund < basePrice) {
      const err = new Error('Insufficient purse');
      err.status = 400;
      throw err;
    }
    fresh.purse = mongoose.Types.Decimal128.fromString(String(purseAfterRefund - basePrice));
    const pid = idStr(playerId);
    if (!(fresh.boughtPlayers || []).some((id) => idStr(id) === pid)) {
      fresh.boughtPlayers.push(playerId);
    }
    await fresh.save();
    chargedTarget = true;

    await setTradeLockOnPlayers([playerId]);

    return {
      ok: true,
      status: 200,
      teamName: fresh.teamName,
      purseAfter: purseAfterRefund - basePrice,
      playerName: player.name,
      cost: basePrice,
    };
  } catch (err) {
    if (chargedTarget && basePrice > 0) {
      try {
        await User.findByIdAndUpdate(teamUserId, {
          $inc: { purse: basePrice },
          $pull: { boughtPlayers: playerId },
        });
      } catch (_) {}
    }
    await rollbackClaim(playerId, createdUserPlayerId);
    if (err.status) {
      return { ok: false, status: err.status, message: err.message };
    }
    if (err.code === 11000) {
      return {
        ok: false,
        status: 400,
        message: 'Duplicate roster record — player may already be assigned',
      };
    }
    throw err;
  }
}

module.exports = {
  planCommissionerPickPurse,
  applyLockRefundToUser,
  executeCommissionerPick,
  purseNum,
};
