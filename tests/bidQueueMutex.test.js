const assert = require("assert");
const { withPlayerBidLock } = require("../utils/bidQueueMutex");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testSamePlayerLocksSerialize() {
  const events = [];

  const first = withPlayerBidLock("player-1", async () => {
    events.push("first:start");
    await delay(25);
    events.push("first:end");
  });

  const second = withPlayerBidLock("player-1", async () => {
    events.push("second:start");
    await delay(1);
    events.push("second:end");
  });

  await Promise.all([first, second]);

  assert.deepStrictEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
}

async function testNestedSamePlayerLockIsReentrant() {
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

async function run() {
  await testSamePlayerLocksSerialize();
  await testNestedSamePlayerLockIsReentrant();
  console.log("bidQueueMutex tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
