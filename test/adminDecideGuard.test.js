const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TRADE_DECIDABLE_STATUSES,
  RELEASE_DECIDABLE_STATUSES,
  PICK_DECIDABLE_STATUSES,
  isAdminDecidableStatus,
  undecidableAdminMessage,
  claimAdminDecision,
  rollbackAdminDecisionClaim,
} = require('../utils/adminDecideGuard');

test('only admin_pending trades are decidable', () => {
  assert.equal(isAdminDecidableStatus('admin_pending', TRADE_DECIDABLE_STATUSES), true);
  assert.equal(isAdminDecidableStatus('pending', TRADE_DECIDABLE_STATUSES), false);
  assert.equal(isAdminDecidableStatus('completed', TRADE_DECIDABLE_STATUSES), false);
  assert.equal(isAdminDecidableStatus('rejected', TRADE_DECIDABLE_STATUSES), false);
});

test('pending and admin_pending releases/picks are decidable; terminal statuses are not', () => {
  for (const allowed of [RELEASE_DECIDABLE_STATUSES, PICK_DECIDABLE_STATUSES]) {
    assert.equal(isAdminDecidableStatus('pending', allowed), true);
    assert.equal(isAdminDecidableStatus('admin_pending', allowed), true);
    assert.equal(isAdminDecidableStatus('completed', allowed), false);
    assert.equal(isAdminDecidableStatus('rejected', allowed), false);
    assert.equal(isAdminDecidableStatus('withdrawn', allowed), false);
  }
});

test('undecidable message names the kind and status', () => {
  assert.equal(
    undecidableAdminMessage('trade', 'completed'),
    "Cannot decide trade with status 'completed'"
  );
});

test('claimAdminDecision only wins once for a decidable status', async () => {
  const store = {
    status: 'admin_pending',
    adminDecision: undefined,
  };
  const Model = {
    async findOneAndUpdate(filter, update) {
      if (!filter.status.$in.includes(store.status)) return null;
      const previous = { _id: 't1', status: store.status, adminDecision: store.adminDecision };
      Object.assign(store, update.$set);
      return previous;
    },
  };

  const first = await claimAdminDecision(Model, 't1', TRADE_DECIDABLE_STATUSES, {
    terminalStatus: 'completed',
    adminDecision: { status: 'approved' },
  });
  assert.equal(first.status, 'admin_pending');
  assert.equal(store.status, 'completed');

  const second = await claimAdminDecision(Model, 't1', TRADE_DECIDABLE_STATUSES, {
    terminalStatus: 'completed',
    adminDecision: { status: 'approved' },
  });
  assert.equal(second, null);
  assert.equal(store.status, 'completed');
});

test('rollbackAdminDecisionClaim restores status and unsets new extras', async () => {
  let updateArg = null;
  const Model = {
    async findByIdAndUpdate(_id, update) {
      updateArg = update;
    },
  };
  await rollbackAdminDecisionClaim(
    Model,
    { _id: 'r1', status: 'pending', adminDecision: undefined, releasedPlayerType: null },
    ['releasedPlayerType', 'pairedPickRequest']
  );
  assert.equal(updateArg.$set.status, 'pending');
  assert.equal(updateArg.$unset.releasedPlayerType, 1);
  assert.equal(updateArg.$unset.pairedPickRequest, 1);
});
