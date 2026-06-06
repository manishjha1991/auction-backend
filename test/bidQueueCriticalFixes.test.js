const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Bid = require("../models/Bid");
const BidPlayerQueue = require("../models/BidPlayerQueue");
const Player = require("../models/Player");
const User = require("../models/User");
const bidQueueService = require("../services/bidQueueService");
const bidRoutes = require("../routes/bidRoutes");

const originals = [];

function stub(target, method, replacement) {
  originals.push([target, method, target[method]]);
  target[method] = replacement;
}

function restoreStubs() {
  while (originals.length) {
    const [target, method, original] = originals.pop();
    target[method] = original;
  }
}

function decimal(value) {
  return mongoose.Types.Decimal128.fromString(String(value));
}

test.afterEach(() => {
  restoreStubs();
});

test("dissolveQueueForPlayer refunds queued waiters and removes stale queue rows", async () => {
  const playerId = new mongoose.Types.ObjectId();
  const queuedUserId = new mongoose.Types.ObjectId();
  const proxyUserId = new mongoose.Types.ObjectId();
  const queueDocId = new mongoose.Types.ObjectId();

  let savedPurse = null;
  let deletedFilter = null;
  const emitted = [];

  stub(BidPlayerQueue, "findOne", async () => ({
    _id: queueDocId,
    entries: [
      { userId: queuedUserId, status: "queued", lockedAmount: 25 },
      { userId: proxyUserId, status: "active_proxy", lockedAmount: 80 },
    ],
  }));
  stub(BidPlayerQueue, "deleteOne", async (filter) => {
    deletedFilter = filter;
  });
  stub(Player, "findById", () => ({
    select: () => ({
      lean: async () => ({ name: "Sold Player" }),
    }),
  }));
  stub(User, "findById", async (userId) => {
    assert.equal(userId.toString(), queuedUserId.toString());
    return {
      purse: decimal(75),
      async save() {
        savedPurse = parseFloat(this.purse.toString());
      },
    };
  });

  const io = {
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };

  const result = await bidQueueService.dissolveQueueForPlayer(playerId, io, "player_sold");

  assert.deepEqual(result, { removedCount: 2, refundedCount: 1 });
  assert.equal(savedPurse, 100);
  assert.deepEqual(deletedFilter, { _id: queueDocId });
  assert.deepEqual(emitted.at(-1), {
    event: "bid_queue_updated",
    payload: { playerId: playerId.toString(), queueCount: 0 },
  });
});

test("system second-highest exit promotes the next queued bidder", async () => {
  const playerId = new mongoose.Types.ObjectId();
  const highestUserId = new mongoose.Types.ObjectId();
  const secondUserId = new mongoose.Types.ObjectId();
  const io = { emit() {} };

  let playerSaved = false;
  let secondUserSaved = false;
  let updatedBidsFilter = null;
  let promotedArgs = null;

  const player = {
    _id: playerId,
    isSold: false,
    currentBid: 25,
    currentBidder: highestUserId,
    async save() {
      playerSaved = true;
    },
  };

  const secondUser = {
    purse: decimal(75),
    currentBids: [{ playerId, amount: 25 }],
    async save() {
      secondUserSaved = true;
    },
  };

  const activeBids = [
    { bidder: highestUserId, bidAmount: 30 },
    { bidder: secondUserId, bidAmount: 25 },
  ];

  stub(Player, "findById", async () => player);
  stub(User, "findById", async (userId) => {
    assert.equal(userId.toString(), secondUserId.toString());
    return secondUser;
  });
  stub(Bid, "find", () => ({
    sort: async () => activeBids,
  }));
  stub(Bid, "updateMany", async (filter) => {
    updatedBidsFilter = filter;
  });
  stub(bidQueueService, "tryPromoteNextQueued", async (promotedPlayerId, promotedIo) => {
    promotedArgs = { promotedPlayerId, promotedIo };
  });

  const result = await bidRoutes.exitSecondHighestForPlayerSingle(playerId.toString(), io);

  assert.equal(result.message, "The second-highest bidder has exited successfully. Locked amount refunded.");
  assert.equal(secondUserSaved, true);
  assert.equal(parseFloat(secondUser.purse.toString()), 100);
  assert.equal(playerSaved, true);
  assert.deepEqual(updatedBidsFilter, { playerId: playerId.toString(), bidder: secondUserId });
  assert.deepEqual(promotedArgs, { promotedPlayerId: playerId.toString(), promotedIo: io });
});
