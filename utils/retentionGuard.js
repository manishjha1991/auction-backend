/**
 * Guards for POST /api/retained-players/retain and /undo/:id.
 *
 * Double-submit retain used to insert two active rows (no unique index) and
 * deduct 17 Cr twice. Sequential/retry undo ignored isActive and refunded again.
 * After season reset, undo stayed allowed while enablePlayerRetention was still
 * true even though adminReleasedPlayers is set specifically to disable undo.
 */

const RETENTION_VALUE = 170000000;
const MAX_RETAINED_PLAYERS = 4;

function isMongoDuplicateKeyError(error) {
  return Boolean(error && (error.code === 11000 || error.code === 11001));
}

function getDuplicateRetentionMessage(error) {
  if (!isMongoDuplicateKeyError(error)) return null;
  const keyPattern = error.keyPattern || {};
  if (keyPattern.playerType) {
    return {
      status: 400,
      message:
        'You already have a player of this category retained. You can only retain one player from each category.',
    };
  }
  return { status: 400, message: 'Player is already retained' };
}

function shouldBlockUndoAfterSeasonRelease(settings, user) {
  if (user && user.allPlayersReleased) return true;
  if (settings && settings.adminReleasedPlayers) return true;
  return false;
}

function getRetentionCreateBlocker({
  settings,
  user,
  player,
  userPlayer,
  existingRetained,
  currentRetainedCount,
  existingCategoryRetained,
  currentPurse,
  retentionValue = RETENTION_VALUE,
} = {}) {
  if (!settings || !settings.enablePlayerRetention) {
    return { status: 403, message: 'Player retention feature is currently disabled by admin' };
  }
  if (!user) {
    return { status: 404, message: 'User not found' };
  }
  if (!user.isActive) {
    return { status: 403, message: 'User account is inactive. Cannot retain players.' };
  }
  if (user.isRetentionLocked) {
    return { status: 403, message: 'Your team retention is locked by admin. You cannot retain players.' };
  }
  if (!player) {
    return { status: 404, message: 'Player not found' };
  }
  if (!userPlayer) {
    return { status: 400, message: 'You do not own this player' };
  }
  if (existingRetained) {
    return { status: 400, message: 'Player is already retained' };
  }
  if (currentRetainedCount >= MAX_RETAINED_PLAYERS) {
    return { status: 400, message: 'You can only retain a maximum of 4 players' };
  }
  if (existingCategoryRetained) {
    return {
      status: 400,
      message: `You already have a ${player.type} player retained. You can only retain one player from each category.`,
    };
  }
  if (currentPurse < retentionValue) {
    return { status: 400, message: 'Insufficient purse balance to retain this player' };
  }
  return null;
}

function getRetentionUndoBlocker({ settings, user, retainedPlayer, actingUserId } = {}) {
  if (!actingUserId) {
    return { status: 400, message: 'User ID is required' };
  }
  if (shouldBlockUndoAfterSeasonRelease(settings, user)) {
    return {
      status: 403,
      message:
        'Cannot undo retained players after admin has released all other players. This action is no longer available.',
    };
  }
  if (!retainedPlayer) {
    return { status: 404, message: 'Retained player not found' };
  }
  if (String(retainedPlayer.userId) !== String(actingUserId)) {
    return { status: 403, message: 'You can only undo your own retained players' };
  }
  if (retainedPlayer.isActive === false) {
    return { status: 409, message: 'This retention has already been undone' };
  }
  if (user && user.isRetentionLocked) {
    return { status: 403, message: 'Your team retention is locked by admin. You cannot undo retained players.' };
  }
  return null;
}

function getActiveRetentionClaimFilter({ retainedPlayerId, userId }) {
  return { _id: retainedPlayerId, userId, isActive: true };
}

module.exports = {
  RETENTION_VALUE,
  MAX_RETAINED_PLAYERS,
  isMongoDuplicateKeyError,
  getDuplicateRetentionMessage,
  shouldBlockUndoAfterSeasonRelease,
  getRetentionCreateBlocker,
  getRetentionUndoBlocker,
  getActiveRetentionClaimFilter,
};
