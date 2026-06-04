const assert = require("assert/strict");
const mongoose = require("mongoose");
const BidPlayerQueue = require("../models/BidPlayerQueue");
const User = require("../models/User");
const bidQueueService = require("../services/bidQueueService");

function userWithPurse(initialPurse) {
  return {
    purse: mongoose.Types.Decimal128.fromString(String(initialPurse)),
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    },
  };
}

async function testRefundsQueuedEntriesOnlyOnSoldPlayerCleanup() {
  const originalFindOne = BidPlayerQueue.findOne;
  const originalDeleteOne = BidPlayerQueue.deleteOne;
  const originalFindById = User.findById;

  const playerId = new mongoose.Types.ObjectId();
  const queuedUserId = new mongoose.Types.ObjectId();
  const secondQueuedUserId = new mongoose.Types.ObjectId();
  const activeProxyUserId = new mongoose.Types.ObjectId();
  const docId = new mongoose.Types.ObjectId();

  const queuedUser = userWithPurse(100);
  const secondQueuedUser = userWithPurse(50);
  const activeProxyUser = userWithPurse(25);
  const users = new Map([
    [queuedUserId.toString(), queuedUser],
    [secondQueuedUserId.toString(), secondQueuedUser],
    [activeProxyUserId.toString(), activeProxyUser],
  ]);

  const queueDoc = {
    _id: docId,
    entries: [
      {
        userId: queuedUserId,
        status: "queued",
        lockedAmount: 75,
      },
      {
        userId: activeProxyUserId,
        status: "active_proxy",
        lockedAmount: 200,
      },
      {
        userId: secondQueuedUserId,
        status: "queued",
        lockedAmount: 30,
      },
    ],
  };
  let deleteFilter = null;

  try {
    BidPlayerQueue.findOne = async (filter) => {
      assert.deepEqual(filter, { playerId });
      return queueDoc;
    };
    BidPlayerQueue.deleteOne = async (filter) => {
      deleteFilter = filter;
      return { deletedCount: 1 };
    };
    User.findById = async (userId) => users.get(userId.toString()) || null;

    const result = await bidQueueService.refundQueueForSoldPlayer(playerId, null);

    assert.deepEqual(result, { refundedCount: 2, refundedAmount: 105 });
    assert.equal(queuedUser.purse.toString(), "175");
    assert.equal(secondQueuedUser.purse.toString(), "80");
    assert.equal(activeProxyUser.purse.toString(), "25");
    assert.equal(queuedUser.saveCalls, 1);
    assert.equal(secondQueuedUser.saveCalls, 1);
    assert.equal(activeProxyUser.saveCalls, 0);
    assert.deepEqual(deleteFilter, { _id: docId });
  } finally {
    BidPlayerQueue.findOne = originalFindOne;
    BidPlayerQueue.deleteOne = originalDeleteOne;
    User.findById = originalFindById;
  }
}

async function run() {
  await testRefundsQueuedEntriesOnlyOnSoldPlayerCleanup();
  console.log("bidQueue sold cleanup tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
