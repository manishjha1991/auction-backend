const assert = require('node:assert/strict');
const test = require('node:test');

const { tradePartiesMatchCurrentOwners } = require('../utils/tradeOwnerMatch');

test('matching current owners allow approval', () => {
  assert.equal(
    tradePartiesMatchCurrentOwners(
      { fromUser: 'teamA', toUser: 'teamB' },
      'teamA',
      'teamB'
    ),
    true
  );
});

test('populated fromUser/toUser refs still match', () => {
  assert.equal(
    tradePartiesMatchCurrentOwners(
      { fromUser: { _id: 'teamA' }, toUser: { _id: 'teamB' } },
      { _id: 'teamA' },
      'teamB'
    ),
    true
  );
});

test('ownership drift after release/repick blocks approval', () => {
  // Original trade was A ↔ B; offered player now owned by C after release→pick
  assert.equal(
    tradePartiesMatchCurrentOwners(
      { fromUser: 'teamA', toUser: 'teamB' },
      'teamC',
      'teamB'
    ),
    false
  );
});

test('swapped owners (already completed elsewhere) block approval', () => {
  assert.equal(
    tradePartiesMatchCurrentOwners(
      { fromUser: 'teamA', toUser: 'teamB' },
      'teamB',
      'teamA'
    ),
    false
  );
});

test('missing party ids fail closed', () => {
  assert.equal(
    tradePartiesMatchCurrentOwners({ fromUser: 'teamA', toUser: null }, 'teamA', 'teamB'),
    false
  );
  assert.equal(
    tradePartiesMatchCurrentOwners({ fromUser: 'teamA', toUser: 'teamB' }, null, 'teamB'),
    false
  );
});
