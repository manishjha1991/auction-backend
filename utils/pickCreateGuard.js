/**
 * Guards for POST /api/picks/ before any purse lock.
 *
 * Duplicate/retry pick creates used to deduct base price again while
 * User.currentBids only stores one amount, so admin reject refunds once
 * and the extra deduction is lost.
 */

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

function getPickCreateBlocker({
  player,
  user,
  existingPendingPick,
  alreadyLockedOnPlayer,
  hasActiveBid,
  now = new Date(),
} = {}) {
  if (!player || player.isSold) {
    return { status: 400, message: 'Player is not available' };
  }
  if (player.isActive) {
    return {
      status: 400,
      message: 'This player is in the live auction pool and cannot be picked from unsold.',
    };
  }

  const fortyEightHoursAgo = new Date(now.getTime() - FORTY_EIGHT_HOURS_MS);
  if (player.releasedAt && new Date(player.releasedAt) > fortyEightHoursAgo) {
    return {
      status: 400,
      message:
        'This player was recently released and cannot be picked from unsold for 48 hours',
    };
  }

  if (!user) {
    return { status: 404, message: 'User not found' };
  }

  if (existingPendingPick) {
    return {
      status: 409,
      message: 'A pick request for this player is already pending admin approval.',
    };
  }

  if (alreadyLockedOnPlayer) {
    return {
      status: 409,
      message:
        'You already have funds locked on this player. Wait for admin decision or ask admin to reject the existing request.',
    };
  }

  if (hasActiveBid) {
    return {
      status: 409,
      message: 'This player already has an active bid and cannot be picked from unsold.',
    };
  }

  return null;
}

module.exports = {
  FORTY_EIGHT_HOURS_MS,
  getPickCreateBlocker,
};
