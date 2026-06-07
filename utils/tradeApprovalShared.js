/**
 * Shared logic for completing a player-for-player trade (admin approves request OR commissioner direct swap).
 * Keeps behaviour identical between /api/trades/admin/:id/decide and /api/admin/roster/trade/execute.
 */
const Player = require('../models/Player');
const TradeRequest = require('../models/TradeRequest');

const TRADE_LOCK_HOURS = 48;

/** Trade lock after a completed swap or after a player is picked from unsold (same window length). */
async function isTradeLocked(playerDoc) {
  if (!playerDoc) return false;
  if (playerDoc.tradeLocked !== true && playerDoc.tradeLocked !== 'true') return false;
  const until = playerDoc.tradeLockedUntil;
  if (!until) {
    await Player.findByIdAndUpdate(playerDoc._id, {
      $set: { tradeLocked: false, tradeLockedUntil: null },
    });
    return false;
  }
  const untilDate = until instanceof Date ? until : new Date(until);
  if (isNaN(untilDate.getTime())) {
    await Player.findByIdAndUpdate(playerDoc._id, {
      $set: { tradeLocked: false, tradeLockedUntil: null },
    });
    return false;
  }
  if (untilDate <= new Date()) {
    await Player.findByIdAndUpdate(playerDoc._id, {
      $set: { tradeLocked: false, tradeLockedUntil: null },
    });
    return false;
  }
  return true;
}

async function setTradeLockOnPlayers(playerIds) {
  const tradeLockedUntil = new Date(Date.now() + TRADE_LOCK_HOURS * 60 * 60 * 1000);
  await Promise.all(
    playerIds.map((pid) =>
      Player.findByIdAndUpdate(pid, { $set: { tradeLocked: true, tradeLockedUntil } }),
    ),
  );
}

/**
 * Auto-reject active trade requests that involve either player.
 * @param {import('mongoose').Types.ObjectId|string} adminUserId
 * @param {Array} playerIds - two player ObjectIds
 * @param {import('mongoose').Types.ObjectId|string|null} excludeTradeId - skip one trade (e.g. the one being decided)
 * @param {string} message - history note for auto-rejected trades
 */
async function autoRejectTradesInvolvingPlayers(
  adminUserId,
  playerIds,
  excludeTradeId = null,
  message = 'Auto-rejected: player traded to another team',
) {
  const activeStatuses = ['pending', 'counter', 'admin_pending'];
  const filter = {
    status: { $in: activeStatuses },
    $or: [
      { offeredPlayer: { $in: playerIds } },
      { requestedPlayer: { $in: playerIds } },
    ],
  };
  if (excludeTradeId) filter._id = { $ne: excludeTradeId };

  const others = await TradeRequest.find(filter);
  for (const o of others) {
    o.status = 'rejected';
    o.history.push({
      byUser: adminUserId,
      action: 'reject',
      message,
    });
    await o.save();
  }
  return others.length;
}

const ACTIVE_TRADE_STATUSES = ['pending', 'counter', 'admin_pending'];

/**
 * Reject all active trade requests involving any of the given players.
 * @returns {{ cleared: number, tradeIds: string[] }}
 */
async function clearActiveTradesForPlayers(
  actorUserId,
  playerIds,
  note = 'Auto-rejected: cleared stuck active trade for player(s)',
) {
  const activeTrades = await TradeRequest.find({
    status: { $in: ACTIVE_TRADE_STATUSES },
    $or: [
      { offeredPlayer: { $in: playerIds } },
      { requestedPlayer: { $in: playerIds } },
    ],
  });

  const tradeIds = [];
  for (const t of activeTrades) {
    t.status = 'rejected';
    if (!t.adminDecision?.status) {
      t.adminDecision = {
        status: 'rejected',
        decidedBy: actorUserId,
        decidedAt: new Date(),
        note: 'Cleared stuck active trade',
      };
    }
    t.history.push({ byUser: actorUserId, action: 'reject', message: note });
    await t.save();
    tradeIds.push(String(t._id));
  }
  return { cleared: tradeIds.length, tradeIds };
}

module.exports = {
  TRADE_LOCK_HOURS,
  isTradeLocked,
  setTradeLockOnPlayers,
  autoRejectTradesInvolvingPlayers,
  clearActiveTradesForPlayers,
  ACTIVE_TRADE_STATUSES,
};
