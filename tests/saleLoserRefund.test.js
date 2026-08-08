const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const {
  SALE_LOSER_USER_SELECT,
  refundOtherBiddersForSoldPlayer,
} = require('../utils/saleLoserRefund');

function makeUser({ id, purse, currentBids }) {
  return {
    _id: { toString: () => id, equals: (other) => String(other) === id },
    purse:
      purse === undefined
        ? undefined
        : mongoose.Types.Decimal128.fromString(String(purse)),
    currentBids: currentBids.map((bid) => ({
      playerId: {
        toString: () => bid.playerId,
        equals: (other) => String(other) === bid.playerId,
      },
      amount: bid.amount,
    })),
    async save() {
      this.saved = true;
    },
  };
}

test('SALE_LOSER_USER_SELECT includes purse', () => {
  assert.match(SALE_LOSER_USER_SELECT, /\bpurse\b/);
  assert.match(SALE_LOSER_USER_SELECT, /\bcurrentBids\b/);
});

test('manual and cron sold paths query losers with SALE_LOSER_USER_SELECT', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'bidRoutes.js'),
    'utf8'
  );
  assert.equal(
    (src.match(/\.select\(SALE_LOSER_USER_SELECT\)/g) || []).length,
    2,
    'both sold paths must select loser users with purse'
  );
  assert.doesNotMatch(
    src,
    /\.select\('_id currentBids'\)/,
    'must not load sale losers without purse'
  );
});

test('refundOtherBiddersForSoldPlayer refunds locked amount and clears currentBids', async () => {
  const winner = makeUser({
    id: 'winner',
    purse: 50,
    currentBids: [{ playerId: 'p1', amount: 20 }],
  });
  const loser = makeUser({
    id: 'loser',
    purse: 80,
    currentBids: [
      { playerId: 'p1', amount: 15 },
      { playerId: 'p2', amount: 10 },
    ],
  });

  await refundOtherBiddersForSoldPlayer({
    mongoose,
    playerId: 'p1',
    winnerId: 'winner',
    users: [winner, loser],
  });

  assert.equal(parseFloat(loser.purse.toString()), 95);
  assert.equal(loser.currentBids.length, 1);
  assert.equal(loser.currentBids[0].playerId.toString(), 'p2');
  assert.equal(loser.saved, true);
  assert.equal(winner.saved, undefined);
});

test('refundOtherBiddersForSoldPlayer fails fast when purse was not selected', async () => {
  const loser = makeUser({
    id: 'loser',
    purse: 80,
    currentBids: [{ playerId: 'p1', amount: 15 }],
  });
  delete loser.purse;

  await assert.rejects(
    () =>
      refundOtherBiddersForSoldPlayer({
        mongoose,
        playerId: 'p1',
        winnerId: 'winner',
        users: [loser],
      }),
    /Missing purse/
  );
});
