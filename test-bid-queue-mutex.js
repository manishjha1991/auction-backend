const assert = require("assert");
const { withPlayerBidLock } = require("./utils/bidQueueMutex");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testConcurrentCallsDoNotOverlap() {
  let inside = 0;
  let maxInside = 0;
  const events = [];

  const first = withPlayerBidLock("player-1", async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    events.push("first:start");
    await delay(25);
    events.push("first:end");
    inside -= 1;
  });

  await delay(5);

  const second = withPlayerBidLock("player-1", async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    events.push("second:start");
    await delay(1);
    events.push("second:end");
    inside -= 1;
  });

  await Promise.all([first, second]);

  assert.strictEqual(maxInside, 1, "same-player lock allowed overlapping callers");
  assert.deepStrictEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
}

async function testNestedCallsRemainReentrant() {
  const events = [];

  await withPlayerBidLock("player-2", async () => {
    events.push("outer:start");
    await withPlayerBidLock("player-2", async () => {
      events.push("inner");
    });
    events.push("outer:end");
  });

  assert.deepStrictEqual(events, ["outer:start", "inner", "outer:end"]);
}

(async () => {
  await testConcurrentCallsDoNotOverlap();
  await testNestedCallsRemainReentrant();
  console.log("bid queue mutex tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
