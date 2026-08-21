const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  filterSoldPlayersExcludingRetained,
} = require('../utils/retentionRelease');

function objectIdLike(hex) {
  return {
    toString() {
      return hex;
    },
  };
}

test('does not release a retained player when ObjectIds are distinct objects', () => {
  const retainedHex = '64a000000000000000000001';
  const otherHex = '64a000000000000000000002';

  const soldPlayers = [
    { _id: objectIdLike(retainedHex), name: 'Retained Star' },
    { _id: objectIdLike(otherHex), name: 'Squad Filler' },
  ];
  const retainedPlayers = [{ playerId: objectIdLike(retainedHex) }];

  // The production bug: Array.includes uses ===, so same-hex ObjectIds miss.
  const retainedIds = retainedPlayers.map((rp) => rp.playerId);
  assert.equal(
    retainedIds.includes(soldPlayers[0]._id),
    false,
    'precondition: reference equality cannot match ObjectIds from separate queries'
  );

  const toRelease = filterSoldPlayersExcludingRetained(soldPlayers, retainedPlayers);
  assert.equal(toRelease.length, 1);
  assert.equal(toRelease[0].name, 'Squad Filler');
});

test('releases every sold player when nobody was retained', () => {
  const soldPlayers = [
    { _id: objectIdLike('64a000000000000000000003'), name: 'A' },
    { _id: objectIdLike('64a000000000000000000004'), name: 'B' },
  ];
  const toRelease = filterSoldPlayersExcludingRetained(soldPlayers, []);
  assert.equal(toRelease.length, 2);
});

test('matches populated retained playerId documents', () => {
  const retainedHex = '64a000000000000000000005';
  const soldPlayers = [{ _id: objectIdLike(retainedHex), name: 'Captain' }];
  const retainedPlayers = [{ playerId: { _id: objectIdLike(retainedHex), name: 'Captain' } }];
  const toRelease = filterSoldPlayersExcludingRetained(soldPlayers, retainedPlayers);
  assert.equal(toRelease.length, 0);
});
