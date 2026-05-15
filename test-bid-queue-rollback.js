const assert = require("assert");
const path = require("path");
const mongoose = require("mongoose");

function stubModule(relativePath, exportsValue) {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function chain(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean() {
      return Promise.resolve(value);
    },
  };
}

(async () => {
  process.env.ENABLE_BID_QUEUE = "true";

  const userId = "queued-user";
  const purseSaves = [];
  const user = {
    _id: userId,
    isLocked: false,
    purse: mongoose.Types.Decimal128.fromString("100"),
    currentBids: [],
    async save() {
      purseSaves.push(this.purse.toString());
    },
  };

  const queueDoc = {
    entries: [],
    async save() {
      throw new Error("queue save failed");
    },
  };

  stubModule("models/BidPlayerQueue.js", {
    findOne: async () => queueDoc,
  });
  stubModule("models/User.js", {
    findById: async () => user,
  });
  stubModule("models/Player.js", {
    findById: async () => ({
      _id: "player-1",
      name: "Test Player",
      type: "Gold",
      isSold: false,
    }),
  });
  stubModule("models/Bid.js", {
    find: () =>
      chain([
        { bidder: { toString: () => "active-1" } },
        { bidder: { toString: () => "active-2" } },
      ]),
    findOne: () => chain({ bidAmount: 10 }),
  });
  stubModule("utils/bidIncrement.js", {
    computeNextBidAmount: () => 10,
    countBidStepsUntilExceedingMax: () => 1,
  });
  stubModule("utils/bidQueueMutex.js", {
    withPlayerBidLock: async (_playerId, fn) => fn(),
  });
  stubModule("services/bidPlacement.js", {
    placeBidCore: async () => ({ ok: true }),
    assertQueueJoinSlotLimits: async () => ({ ok: true }),
  });
  stubModule("utils/socketUserMap.js", {
    getSocketIdsForUsers: () => [],
  });

  const servicePath = require.resolve(path.join(__dirname, "services/bidQueueService.js"));
  delete require.cache[servicePath];
  const bidQueueService = require(servicePath);

  let thrown;
  try {
    await bidQueueService.enqueueUser({
      playerId: "player-1",
      userId,
      maxBid: 50,
      io: null,
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown, "expected enqueueUser to surface the queue save failure");
  assert.strictEqual(thrown.message, "queue save failed");
  assert.deepStrictEqual(
    purseSaves,
    ["50", "100"],
    "failed queue save should roll the deducted purse back to its original value"
  );

  console.log("bid queue purse rollback test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
