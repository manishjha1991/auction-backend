const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  planCommissionerPickPurse,
  applyLockRefundToUser,
} = require('../utils/adminRosterPick');

const BASE = 20_000_000;
const TEAM_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const PLAYER = 'cccccccccccccccccccccccc';

test('same-team pending pick: refund then charge nets zero extra', () => {
  const plan = planCommissionerPickPurse({
    basePrice: BASE,
    targetUserId: TEAM_A,
    locks: [{ userId: TEAM_A, amount: BASE }],
  });
  assert.equal(plan.netByUser[TEAM_A], 0);
  assert.equal(plan.charge, BASE);
});

test('other-team pending pick: other team is refunded, destination is charged once', () => {
  const plan = planCommissionerPickPurse({
    basePrice: BASE,
    targetUserId: TEAM_B,
    locks: [{ userId: TEAM_A, amount: BASE }],
  });
  assert.equal(plan.netByUser[TEAM_A], BASE);
  assert.equal(plan.netByUser[TEAM_B], -BASE);
});

test('no pending lock: destination is charged base price once', () => {
  const plan = planCommissionerPickPurse({
    basePrice: BASE,
    targetUserId: TEAM_A,
    locks: [],
  });
  assert.equal(plan.netByUser[TEAM_A], -BASE);
});

test('legacy execute dropped currentBids without refund — that net is -2x base', () => {
  // Old path: pick create already deducted BASE, execute deducted BASE again
  // and stripped currentBids with no refund.
  const afterCreate = -BASE;
  const afterBrokenExecute = afterCreate - BASE;
  assert.equal(afterBrokenExecute, -2 * BASE);

  const plan = planCommissionerPickPurse({
    basePrice: BASE,
    targetUserId: TEAM_A,
    locks: [{ userId: TEAM_A, amount: BASE }],
  });
  assert.equal(afterCreate + plan.netByUser[TEAM_A], -BASE);
});

test('applyLockRefundToUser restores purse and clears the slot', () => {
  const user = {
    purse: mongoose.Types.Decimal128.fromString(String(80_000_000)),
    currentBids: [{ playerId: PLAYER, amount: BASE }],
  };
  const { refunded } = applyLockRefundToUser(user, PLAYER);
  assert.equal(refunded, BASE);
  assert.equal(parseFloat(user.purse.toString()), 100_000_000);
  assert.equal(user.currentBids.length, 0);
});

test('applyLockRefundToUser is a no-op when the player is not locked', () => {
  const user = {
    purse: mongoose.Types.Decimal128.fromString(String(80_000_000)),
    currentBids: [{ playerId: TEAM_B, amount: BASE }],
  };
  const { refunded } = applyLockRefundToUser(user, PLAYER);
  assert.equal(refunded, 0);
  assert.equal(user.currentBids.length, 1);
  assert.equal(parseFloat(user.purse.toString()), 80_000_000);
});
