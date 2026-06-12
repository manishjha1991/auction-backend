const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const root = path.resolve(__dirname, "..");

function stubModule(relativePath, exports) {
  const fullPath = path.join(root, relativePath);
  require.cache[require.resolve(fullPath)] = {
    id: fullPath,
    filename: fullPath,
    loaded: true,
    exports,
  };
}

test("clearQueueAfterPlayerSold refunds queued entries and removes stale queue rows", async () => {
  const servicePath = path.join(root, "services", "bidQueueService.js");
  delete require.cache[require.resolve(servicePath)];

  const playerId = new mongoose.Types.ObjectId();
  const queueDocId = new mongoose.Types.ObjectId();
  const queuedUserId = new mongoose.Types.ObjectId();
  const proxyUserId = new mongoose.Types.ObjectId();

  const users = new Map([
    [
      queuedUserId.toString(),
      {
        purse: mongoose.Types.Decimal128.fromString("10"),
        saveCount: 0,
        async save() {
          this.saveCount += 1;
        },
      },
    ],
    [
      proxyUserId.toString(),
      {
        purse: mongoose.Types.Decimal128.fromString("10"),
        saveCount: 0,
        async save() {
          this.saveCount += 1;
        },
      },
    ],
  ]);

  const queueDoc = {
    _id: queueDocId,
    entries: [
      {
        _id: new mongoose.Types.ObjectId(),
        userId: queuedUserId,
        maxBid: 25,
        status: "queued",
        lockedAmount: 25,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        userId: proxyUserId,
        maxBid: 40,
        status: "active_proxy",
        lockedAmount: 40,
      },
    ],
  };

  let deletedQuery = null;
  const emitted = [];

  stubModule("models/BidPlayerQueue.js", {
    async findOne(query) {
      assert.equal(query.playerId.toString(), playerId.toString());
      return queueDoc;
    },
    async deleteOne(query) {
      deletedQuery = query;
      return { deletedCount: 1 };
    },
  });
  stubModule("models/User.js", {
    async findById(userId) {
      return users.get(userId.toString()) || null;
    },
  });
  stubModule("models/Player.js", {
    findById(id) {
      assert.equal(id.toString(), playerId.toString());
      return {
        select() {
          return {
            async lean() {
              return { name: "Queued Player" };
            },
          };
        },
      };
    },
  });
  stubModule("models/Bid.js", {});
  stubModule("utils/bidIncrement.js", {
    computeNextBidAmount() {
      throw new Error("not used");
    },
    countBidStepsUntilExceedingMax() {
      throw new Error("not used");
    },
  });
  stubModule("utils/bidQueueMutex.js", {
    async withPlayerBidLock(_playerId, fn) {
      return fn();
    },
  });
  stubModule("services/bidPlacement.js", {
    placeBidCore() {
      throw new Error("not used");
    },
    assertQueueJoinSlotLimits() {
      throw new Error("not used");
    },
  });
  stubModule("utils/socketUserMap.js", {
    getSocketIdsForUsers() {
      return [];
    },
  });

  const bidQueueService = require(servicePath);
  const result = await bidQueueService.clearQueueAfterPlayerSold(playerId, {
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  });

  assert.deepEqual(result, {
    refundedCount: 1,
    refundedAmount: 25,
    removedCount: 2,
  });
  assert.equal(users.get(queuedUserId.toString()).purse.toString(), "35");
  assert.equal(users.get(queuedUserId.toString()).saveCount, 1);
  assert.equal(users.get(proxyUserId.toString()).purse.toString(), "10");
  assert.equal(users.get(proxyUserId.toString()).saveCount, 0);
  assert.equal(deletedQuery._id.toString(), queueDocId.toString());
  assert.deepEqual(emitted, [
    {
      event: "bid_queue_updated",
      payload: {
        playerId: playerId.toString(),
        queueCount: 0,
      },
    },
  ]);
});
