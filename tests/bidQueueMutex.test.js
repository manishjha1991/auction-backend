const assert = require("assert");
const { withPlayerBidLock } = require("../utils/bidQueueMutex");

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testSamePlayerCallsAreSerialized() {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const releaseFirstPromise = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];

  const first = withPlayerBidLock("player-a", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("first:start");
    firstStarted();
    await releaseFirstPromise;
    order.push("first:end");
    active -= 1;
    return "first";
  });

  await firstStartedPromise;

  const second = withPlayerBidLock("player-a", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push("second:start");
    active -= 1;
    return "second";
  });

  await delay(10);
  assert.deepStrictEqual(order, ["first:start"]);
  assert.strictEqual(maxActive, 1);

  releaseFirst();
  assert.strictEqual(await first, "first");
  assert.strictEqual(await second, "second");
  assert.deepStrictEqual(order, ["first:start", "first:end", "second:start"]);
  assert.strictEqual(maxActive, 1);
}

async function testNestedSamePlayerCallIsReentrant() {
  const order = [];
  const result = await withPlayerBidLock("player-b", async () => {
    order.push("outer:start");
    const inner = await withPlayerBidLock("player-b", async () => {
      order.push("inner");
      return "inner-result";
    });
    order.push("outer:end");
    return inner;
  });

  assert.strictEqual(result, "inner-result");
  assert.deepStrictEqual(order, ["outer:start", "inner", "outer:end"]);
}

async function testFailedCallerDoesNotPoisonQueue() {
  const failure = withPlayerBidLock("player-c", async () => {
    throw new Error("boom");
  });
  const afterFailure = withPlayerBidLock("player-c", async () => "after");

  await assert.rejects(failure, /boom/);
  assert.strictEqual(await afterFailure, "after");
}

async function main() {
  await testSamePlayerCallsAreSerialized();
  await testNestedSamePlayerCallIsReentrant();
  await testFailedCallerDoesNotPoisonQueue();
  console.log("bidQueueMutex tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
