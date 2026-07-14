const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

function installStub(request, exports) {
  const filename = require.resolve(request);
  const previous = require.cache[filename];
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
  };
}

test("selling a player refunds queued reservations and clears queue metadata", async () => {
  const users = new Map([
    ["queued-1", { purse: mongoose.Types.Decimal128.fromString("100"), saveCount: 0 }],
    ["queued-2", { purse: mongoose.Types.Decimal128.fromString("100"), saveCount: 0 }],
    ["active-proxy", { purse: mongoose.Types.Decimal128.fromString("75"), saveCount: 0 }],
  ]);
  for (const user of users.values()) {
    user.save = async function save() {
      this.saveCount += 1;
    };
  }

  const entries = [
    { _id: "entry-1", userId: "queued-1", status: "queued", lockedAmount: 20 },
    { _id: "entry-2", userId: "queued-2", status: "queued", lockedAmount: 50 },
    { _id: "entry-3", userId: "active-proxy", status: "active_proxy", lockedAmount: 75 },
  ];
  entries.id = (id) => entries.find((entry) => entry._id === id);
  entries.pull = (id) => {
    const index = entries.findIndex((entry) => entry._id === id);
    if (index >= 0) entries.splice(index, 1);
  };

  const queueDocument = {
    entries,
    save: async () => {},
  };
  let deletedPlayerId = null;
  let lockCalls = 0;

  const restoreStubs = [
    installStub("./models/BidPlayerQueue", {
      findOne: async () => queueDocument,
      deleteOne: async ({ playerId }) => {
        deletedPlayerId = playerId;
      },
    }),
    installStub("./models/User", {
      findById: async (userId) => users.get(userId),
    }),
    installStub("./models/Player", {
      findById: () => ({
        select: () => ({
          lean: async () => ({ name: "Test Player" }),
        }),
      }),
    }),
    installStub("./models/Bid", {}),
    installStub("./services/bidPlacement", {
      placeBidCore: async () => ({ ok: true }),
      assertQueueJoinSlotLimits: async () => ({ ok: true }),
    }),
    installStub("./utils/bidQueueMutex", {
      withPlayerBidLock: async (_playerId, work) => {
        lockCalls += 1;
        return work();
      },
    }),
    installStub("./utils/socketUserMap", {
      getSocketIdsForUsers: () => [],
    }),
  ];

  const servicePath = require.resolve("./services/bidQueueService");
  delete require.cache[servicePath];

  try {
    const bidQueueService = require("./services/bidQueueService");
    await bidQueueService.clearQueueAfterPlayerSold("player-1", null);

    assert.equal(users.get("queued-1").purse.toString(), "120");
    assert.equal(users.get("queued-2").purse.toString(), "150");
    assert.equal(users.get("queued-1").saveCount, 1);
    assert.equal(users.get("queued-2").saveCount, 1);
    assert.equal(users.get("active-proxy").purse.toString(), "75");
    assert.equal(users.get("active-proxy").saveCount, 0);
    assert.deepEqual(entries.map((entry) => entry.status), ["active_proxy"]);
    assert.equal(deletedPlayerId, "player-1");
    assert.equal(lockCalls, 1);
  } finally {
    delete require.cache[servicePath];
    restoreStubs.reverse().forEach((restore) => restore());
  }
});
