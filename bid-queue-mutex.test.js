const assert = require("node:assert/strict");
const test = require("node:test");
const { withPlayerBidLock } = require("./utils/bidQueueMutex");

test("player lock serializes concurrent work while allowing true nested work", async () => {
  const events = [];
  let releaseFirst;
  let signalStarted;
  const firstStarted = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = withPlayerBidLock("player-1", async () => {
    events.push("first:start");
    signalStarted();
    await withPlayerBidLock("player-1", async () => {
      events.push("first:nested");
    });
    await holdFirst;
    events.push("first:end");
  });

  await firstStarted;
  const second = withPlayerBidLock("player-1", async () => {
    events.push("second");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start", "first:nested"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:nested", "first:end", "second"]);
});
