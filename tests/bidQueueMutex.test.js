const assert = require("assert/strict");
const { withPlayerBidLock } = require("../utils/bidQueueMutex");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function testConcurrentCallersDoNotOverlap() {
  const enteredFirst = deferred();
  const releaseFirst = deferred();
  const events = [];
  let firstStillHolding = false;
  let secondEnteredWhileFirstHeld = false;

  const first = withPlayerBidLock("player-1", async () => {
    events.push("first:start");
    firstStillHolding = true;

    await withPlayerBidLock("player-1", async () => {
      events.push("nested");
    });

    enteredFirst.resolve();
    await releaseFirst.promise;
    firstStillHolding = false;
    events.push("first:end");
  });

  await enteredFirst.promise;

  const second = withPlayerBidLock("player-1", async () => {
    if (firstStillHolding) {
      secondEnteredWhileFirstHeld = true;
    }
    events.push("second");
  });

  await flushMicrotasks();
  assert.equal(
    secondEnteredWhileFirstHeld,
    false,
    "independent callers for the same player must not overlap"
  );
  assert.deepEqual(events, ["first:start", "nested"]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "nested", "first:end", "second"]);
}

async function testRejectedCallerDoesNotPoisonQueue() {
  await assert.rejects(
    withPlayerBidLock("player-2", async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  const result = await withPlayerBidLock("player-2", async () => "next caller ran");
  assert.equal(result, "next caller ran");
}

async function run() {
  await testConcurrentCallersDoNotOverlap();
  await testRejectedCallerDoesNotPoisonQueue();
  console.log("bidQueueMutex tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
