const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { countBoughtAndBiddingByType } = require('../utils/lockUnderLimitCounts');

test('6 bought Gold + 1 bidding Gold totals 7 (must not double-count bidding)', () => {
  const bought = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
  const biddingId = 'g7';
  const players = [...bought, biddingId].map((id) => ({ _id: id, type: 'Gold' }));
  const currentBids = [{ playerId: biddingId, amount: 20000000 }];

  const { boughtCounts, biddingCounts } = countBoughtAndBiddingByType(
    players,
    bought,
    currentBids
  );

  assert.equal(boughtCounts.Gold, 6);
  assert.equal(biddingCounts.Gold, 1);
  assert.equal((boughtCounts.Gold || 0) + (biddingCounts.Gold || 0), 7);
});

test('Silver bidding is not added into silverBought', () => {
  const players = [
    { _id: 's1', type: 'Silver' },
    { _id: 's2', type: 'Silver' },
    { _id: 'sBid', type: 'Silver' },
  ];
  const { boughtCounts, biddingCounts } = countBoughtAndBiddingByType(
    players,
    ['s1', 's2'],
    [{ playerId: 'sBid' }]
  );
  assert.equal(boughtCounts.Silver, 2);
  assert.equal(biddingCounts.Silver, 1);
  assert.equal((boughtCounts.Silver || 0) + (biddingCounts.Silver || 0), 3);
});

test('lockUnderLimitAll uses boughtCounts/biddingCounts helper (not combined counts + re-add)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bidRoutes.js'), 'utf8');
  const fnStart = src.indexOf('async function lockUnderLimitAll');
  const fnEnd = src.indexOf("router.post('/lock-under-limit/all'");
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const fn = src.slice(fnStart, fnEnd);

  assert.match(fn, /countBoughtAndBiddingByType/);
  assert.match(fn, /boughtCounts\['Gold'\]/);
  assert.match(fn, /biddingCounts\['Gold'\]/);
  assert.match(fn, /boughtCounts\['Silver'\]/);
  assert.match(fn, /biddingCounts\['Silver'\]/);
  assert.doesNotMatch(
    fn,
    /const counts = players\.reduce/,
    'must not rebuild a combined type tally that includes currentBids'
  );
});
