const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getPickCreateBlocker } = require('../utils/pickCreateGuard');

const unsoldPlayer = {
  _id: 'p1',
  isSold: false,
  isActive: false,
  releasedAt: null,
};

const user = { _id: 'u1', purse: 100 };

test('allows a first pick on an unsold inactive player', () => {
  assert.equal(
    getPickCreateBlocker({
      player: unsoldPlayer,
      user,
      existingPendingPick: null,
      alreadyLockedOnPlayer: false,
      hasActiveBid: false,
    }),
    null
  );
});

test('rejects a second pending pick for the same player (retry / double-submit)', () => {
  const blocker = getPickCreateBlocker({
    player: unsoldPlayer,
    user,
    existingPendingPick: { _id: 'pick1' },
    alreadyLockedOnPlayer: true,
    hasActiveBid: true,
  });
  assert.equal(blocker.status, 409);
  assert.match(blocker.message, /already pending/i);
});

test('rejects when funds are already locked even if the pick row is missing', () => {
  const blocker = getPickCreateBlocker({
    player: unsoldPlayer,
    user,
    existingPendingPick: null,
    alreadyLockedOnPlayer: true,
    hasActiveBid: false,
  });
  assert.equal(blocker.status, 409);
  assert.match(blocker.message, /funds locked/i);
});

test('rejects pick of a player currently in the live auction pool', () => {
  const blocker = getPickCreateBlocker({
    player: { ...unsoldPlayer, isActive: true },
    user,
    existingPendingPick: null,
    alreadyLockedOnPlayer: false,
    hasActiveBid: false,
  });
  assert.equal(blocker.status, 400);
  assert.match(blocker.message, /live auction/i);
});

test('rejects pick of a sold player', () => {
  const blocker = getPickCreateBlocker({
    player: { ...unsoldPlayer, isSold: true },
    user,
    existingPendingPick: null,
    alreadyLockedOnPlayer: false,
    hasActiveBid: false,
  });
  assert.equal(blocker.status, 400);
});

test('rejects pick when another team already has an active bid', () => {
  const blocker = getPickCreateBlocker({
    player: unsoldPlayer,
    user,
    existingPendingPick: null,
    alreadyLockedOnPlayer: false,
    hasActiveBid: true,
  });
  assert.equal(blocker.status, 409);
  assert.match(blocker.message, /active bid/i);
});

test('still enforces the 48h post-release window', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  const blocker = getPickCreateBlocker({
    player: { ...unsoldPlayer, releasedAt: new Date('2026-08-14T10:00:00Z') },
    user,
    existingPendingPick: null,
    alreadyLockedOnPlayer: false,
    hasActiveBid: false,
    now,
  });
  assert.equal(blocker.status, 400);
  assert.match(blocker.message, /48 hours/);
});

test('pick create route consults the guard before locking purse', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'picks.js'),
    'utf8'
  );
  assert.match(src, /getPickCreateBlocker/);
  const guardIdx = src.indexOf('getPickCreateBlocker');
  const deductIdx = src.indexOf('purse - basePrice');
  const createIdx = src.indexOf('PickRequest.create');
  assert.ok(guardIdx > 0, 'route must call getPickCreateBlocker');
  assert.ok(createIdx > guardIdx, 'pending pick row must be created after the guard');
  assert.ok(deductIdx > createIdx, 'purse deduct must happen after the pending pick row exists');
});

test('PickRequest declares a unique pending-pick-per-player index', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'models', 'PickRequest.js'),
    'utf8'
  );
  assert.match(src, /uniq_pending_pick_per_player/);
  assert.match(src, /partialFilterExpression/);
});
