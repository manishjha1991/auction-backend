const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RETENTION_VALUE,
  getRetentionCreateBlocker,
  getRetentionUndoBlocker,
  getDuplicateRetentionMessage,
  shouldBlockUndoAfterSeasonRelease,
  getActiveRetentionClaimFilter,
} = require('../utils/retentionGuard');

const settingsOpen = { enablePlayerRetention: true, adminReleasedPlayers: false };
const user = {
  _id: 'u1',
  isActive: true,
  isRetentionLocked: false,
  allPlayersReleased: false,
};
const player = { _id: 'p1', type: 'Gold', name: 'Star' };
const userPlayer = { _id: 'up1', userId: 'u1', playerId: 'p1' };
const retained = { _id: 'rp1', userId: 'u1', isActive: true, retainedValue: RETENTION_VALUE };

test('allows a first retain during the retention window', () => {
  assert.equal(
    getRetentionCreateBlocker({
      settings: settingsOpen,
      user,
      player,
      userPlayer,
      existingRetained: null,
      currentRetainedCount: 0,
      existingCategoryRetained: null,
      currentPurse: RETENTION_VALUE,
    }),
    null
  );
});

test('rejects a second retain of the same player (retry / double-submit)', () => {
  const blocker = getRetentionCreateBlocker({
    settings: settingsOpen,
    user,
    player,
    userPlayer,
    existingRetained: { _id: 'rp-existing' },
    currentRetainedCount: 1,
    existingCategoryRetained: { _id: 'rp-existing' },
    currentPurse: RETENTION_VALUE * 2,
  });
  assert.equal(blocker.status, 400);
  assert.match(blocker.message, /already retained/i);
});

test('maps a player unique-index violation to already retained', () => {
  const msg = getDuplicateRetentionMessage({
    code: 11000,
    keyPattern: { userId: 1, playerId: 1 },
  });
  assert.equal(msg.status, 400);
  assert.match(msg.message, /already retained/i);
});

test('maps a category unique-index violation to one-per-type', () => {
  const msg = getDuplicateRetentionMessage({
    code: 11000,
    keyPattern: { userId: 1, playerType: 1 },
  });
  assert.equal(msg.status, 400);
  assert.match(msg.message, /each category/i);
});

test('undo is blocked when the row is already inactive (retry refund)', () => {
  const blocker = getRetentionUndoBlocker({
    settings: settingsOpen,
    user,
    retainedPlayer: { ...retained, isActive: false },
    actingUserId: 'u1',
  });
  assert.equal(blocker.status, 409);
  assert.match(blocker.message, /already been undone/i);
});

test('undo is allowed during the retention window', () => {
  assert.equal(
    getRetentionUndoBlocker({
      settings: settingsOpen,
      user,
      retainedPlayer: retained,
      actingUserId: 'u1',
    }),
    null
  );
});

test('old guard would not block undo after season reset while retention stays enabled', () => {
  const settings = { enablePlayerRetention: true, adminReleasedPlayers: true };
  const oldGuard = settings.adminReleasedPlayers && settings.enablePlayerRetention !== true;
  assert.equal(oldGuard, false);
  assert.equal(shouldBlockUndoAfterSeasonRelease(settings, user), true);
});

test('undo is blocked after adminReleasedPlayers even if retention is still enabled', () => {
  const blocker = getRetentionUndoBlocker({
    settings: { enablePlayerRetention: true, adminReleasedPlayers: true },
    user,
    retainedPlayer: retained,
    actingUserId: 'u1',
  });
  assert.equal(blocker.status, 403);
  assert.match(blocker.message, /released all other players/i);
});

test('undo is blocked after the team allPlayersReleased flag is set', () => {
  const blocker = getRetentionUndoBlocker({
    settings: settingsOpen,
    user: { ...user, allPlayersReleased: true },
    retainedPlayer: retained,
    actingUserId: 'u1',
  });
  assert.equal(blocker.status, 403);
});

test('claim filter requires the active row owned by the acting user', () => {
  assert.deepEqual(getActiveRetentionClaimFilter({ retainedPlayerId: 'rp1', userId: 'u1' }), {
    _id: 'rp1',
    userId: 'u1',
    isActive: true,
  });
});
