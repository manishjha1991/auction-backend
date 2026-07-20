const assert = require("node:assert/strict");
const test = require("node:test");

function stubModule(path, exports, originals) {
  const resolved = require.resolve(path);
  originals.set(resolved, require.cache[resolved]);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

test("manual bids count queued players against the roster limit", async (t) => {
  const originalQueueFlag = process.env.ENABLE_BID_QUEUE;
  process.env.ENABLE_BID_QUEUE = "true";

  const originals = new Map();
  const bidPlacementPath = require.resolve("../services/bidPlacement");
  originals.set(bidPlacementPath, require.cache[bidPlacementPath]);

  t.after(() => {
    if (originalQueueFlag === undefined) {
      delete process.env.ENABLE_BID_QUEUE;
    } else {
      process.env.ENABLE_BID_QUEUE = originalQueueFlag;
    }
    for (const [path, cached] of originals) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  });

  const boughtPlayers = Array.from({ length: 7 }, (_, index) => `owned-${index}`);
  const user = {
    _id: "user-1",
    boughtPlayers,
    currentBids: [],
    isLocked: false,
  };

  stubModule(
    "../models/Player",
    {
      findById: async () => ({ _id: "new-gold", type: "Gold", isSold: false }),
      countDocuments: async (query) => query._id.$in.length,
    },
    originals
  );
  stubModule("../models/User", { findById: async () => user }, originals);
  stubModule("../models/RetainedPlayer", { countDocuments: async () => 0 }, originals);
  stubModule(
    "../models/BidPlayerQueue",
    {
      find: () => ({
        populate() {
          return this;
        },
        async lean() {
          return [
            {
              playerId: { _id: "queued-gold", type: "Gold" },
              entries: [{ userId: "user-1", status: "queued" }],
            },
          ];
        },
      }),
    },
    originals
  );
  stubModule("../models/Bid", {}, originals);
  stubModule("../models/BidNotification", function BidNotification() {}, originals);

  delete require.cache[bidPlacementPath];
  const { placeBidCore } = require("../services/bidPlacement");

  const result = await placeBidCore({
    playerId: "new-gold",
    bidderId: "user-1",
    clientIP: "127.0.0.1",
    deviceFingerprint: "test",
    isSuspiciousIP: false,
    io: null,
  });

  assert.deepEqual(
    { ok: result.ok, status: result.status },
    { ok: false, status: 400 }
  );
  assert.match(result.message, /7 bought Gold.*1 queued = 8 total/);
});
