const assert = require("node:assert/strict");
const test = require("node:test");
const { withPlayerBidLock } = require("../utils/bidQueueMutex");

function createGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("serializes concurrent work for the same player", async () => {
  const events = [];
  const firstMayFinish = createGate();
  const firstStarted = createGate();
  let secondEntered = false;

  const first = withPlayerBidLock("player-concurrent", async () => {
    events.push("first-start");
    firstStarted.release();
    await firstMayFinish.promise;
    events.push("first-end");
  });

  await firstStarted.promise;

  const second = withPlayerBidLock("player-concurrent", async () => {
    secondEntered = true;
    events.push("second-start");
  });

  await Promise.resolve();
  assert.equal(secondEntered, false);

  firstMayFinish.release();
  await Promise.all([first, second]);

  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("allows true nested locking for the same player", async () => {
  const events = [];

  await withPlayerBidLock("player-reentrant", async () => {
    events.push("outer-start");
    await withPlayerBidLock("player-reentrant", async () => {
      events.push("inner");
    });
    events.push("outer-end");
  });

  assert.deepEqual(events, ["outer-start", "inner", "outer-end"]);
});

test("allows different players to proceed independently", async () => {
  const firstMayFinish = createGate();
  const firstStarted = createGate();
  let otherEntered = false;

  const first = withPlayerBidLock("player-a", async () => {
    firstStarted.release();
    await firstMayFinish.promise;
  });

  await firstStarted.promise;

  await withPlayerBidLock("player-b", async () => {
    otherEntered = true;
  });

  assert.equal(otherEntered, true);
  firstMayFinish.release();
  await first;
});
