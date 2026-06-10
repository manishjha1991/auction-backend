const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

test("player profile picture upload requires JWT before processing the file", () => {
  const playerRoutes = require("../routes/players");
  const routeLayer = playerRoutes.stack.find(
    (layer) =>
      layer.route?.path === "/:playerId/admin/profile-picture" &&
      layer.route?.methods?.post
  );

  assert.ok(routeLayer, "profile picture route should be registered");
  const handlers = routeLayer.route.stack.map((layer) => layer.handle.name);
  assert.deepEqual(handlers, [
    "authenticateJWT",
    "multerMiddleware",
    "handleAdminProfilePictureLocal",
  ]);
});

test("drainBidQueueOnPlayerSold refunds queued entries and removes the queue", async (t) => {
  const BidPlayerQueue = require("../models/BidPlayerQueue");
  const Player = require("../models/Player");
  const User = require("../models/User");
  const bidQueueService = require("../services/bidQueueService");

  const originals = {
    findQueue: BidPlayerQueue.findOne,
    deleteQueue: BidPlayerQueue.deleteOne,
    findPlayer: Player.findById,
    findUser: User.findById,
  };
  t.after(() => {
    BidPlayerQueue.findOne = originals.findQueue;
    BidPlayerQueue.deleteOne = originals.deleteQueue;
    Player.findById = originals.findPlayer;
    User.findById = originals.findUser;
  });

  const queuedUserId = new mongoose.Types.ObjectId();
  const proxyUserId = new mongoose.Types.ObjectId();
  const playerId = new mongoose.Types.ObjectId();
  const queueDocId = new mongoose.Types.ObjectId();
  const savedUsers = [];
  const emitted = [];
  let deletedFilter = null;

  BidPlayerQueue.findOne = async () => ({
    _id: queueDocId,
    entries: [
      {
        userId: queuedUserId,
        status: "queued",
        lockedAmount: 250,
      },
      {
        userId: proxyUserId,
        status: "active_proxy",
        lockedAmount: 500,
      },
    ],
  });
  BidPlayerQueue.deleteOne = async (filter) => {
    deletedFilter = filter;
  };
  Player.findById = () => ({
    select: () => ({
      lean: async () => ({ name: "Sold Player" }),
    }),
  });
  User.findById = async (userId) => {
    assert.equal(userId.toString(), queuedUserId.toString(), "only queued users are refunded");
    return {
      purse: mongoose.Types.Decimal128.fromString("1000"),
      async save() {
        savedUsers.push(this.purse.toString());
      },
    };
  };

  const io = {
    emit(event, payload) {
      emitted.push({ event, payload });
    },
  };

  const result = await bidQueueService.drainBidQueueOnPlayerSold(playerId, io);

  assert.deepEqual(result, { refundedCount: 1, refundedAmount: 250 });
  assert.deepEqual(savedUsers, ["1250"]);
  assert.deepEqual(deletedFilter, { _id: queueDocId });
  assert.ok(
    emitted.some(
      ({ event, payload }) =>
        event === "bid_queue_updated" &&
        payload.playerId === playerId.toString() &&
        payload.queueCount === 0
    ),
    "queue listeners should see zero queued entries after sale"
  );
});
