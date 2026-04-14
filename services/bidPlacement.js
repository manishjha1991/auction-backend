const mongoose = require("mongoose");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const User = require("../models/User");
const RetainedPlayer = require("../models/RetainedPlayer");
const BidPlayerQueue = require("../models/BidPlayerQueue");
const BidNotification = require("../models/BidNotification");
const { invalidateCache } = require("../utils/cache");
const { computeNextBidAmount } = require("../utils/bidIncrement");
const { getSocketIdsForUsers } = require("../utils/socketUserMap");

const TYPE_LIMIT = {
  Sapphire: 2,
  Gold: 8,
  Emerald: 4,
  Silver: 6,
};

/** Per-user queued rows (status queued) for slot limits — one row per player lot. */
async function countQueuedSlotsForUser(userId, excludePlayerId = null) {
  const uid = userId.toString();
  const excl = excludePlayerId ? String(excludePlayerId) : null;
  const docs = await BidPlayerQueue.find({ "entries.userId": userId })
    .populate("playerId", "type")
    .lean();

  let totalQueued = 0;
  const byType = { Sapphire: 0, Gold: 0, Emerald: 0, Silver: 0 };
  let esQueued = 0;

  for (const doc of docs) {
    const pid = doc.playerId?._id?.toString() || doc.playerId?.toString();
    if (excl && pid === excl) continue;
    const has = doc.entries?.some(
      (e) => e.userId.toString() === uid && e.status === "queued"
    );
    if (!has) continue;
    totalQueued += 1;
    const t = doc.playerId?.type;
    if (t && Object.prototype.hasOwnProperty.call(byType, t)) byType[t] += 1;
    if (t === "Emerald" || t === "Sapphire") esQueued += 1;
  }
  return { totalQueued, byType, esQueued };
}

/**
 * Same engagement rules as placeBidCore, counting existing bid-queue rows as using a slot.
 */
async function assertQueueJoinSlotLimits(userId, playerId) {
  const player = await Player.findById(playerId);
  if (!player) {
    return { ok: false, message: "Player not found." };
  }
  const user = await User.findById(userId).lean();
  if (!user) {
    return { ok: false, message: "User not found." };
  }

  const { totalQueued, byType, esQueued } = await countQueuedSlotsForUser(userId, null);
  const queuedOfThisType = byType[player.type] || 0;
  const combinedESLimit = 5;

  const [boughtPlayersOfThisType, currentBidPlayersOfThisType] = await Promise.all([
    Player.countDocuments({
      _id: { $in: user.boughtPlayers || [] },
      type: player.type,
    }),
    Player.countDocuments({
      _id: { $in: (user.currentBids || []).map((bid) => bid.playerId) },
      type: player.type,
    }),
  ]);

  const totalTypeCount = boughtPlayersOfThisType + currentBidPlayersOfThisType;
  if (totalTypeCount + queuedOfThisType >= TYPE_LIMIT[player.type]) {
    return {
      ok: false,
      message: `Joining the queue would exceed your ${player.type} limit (${TYPE_LIMIT[player.type]}). That count includes ${queuedOfThisType} other ${player.type} queue slot(s). Exit an auction or wait for a queue to clear.`,
    };
  }

  const combinedESCount = await Player.countDocuments({
    _id: [...(user.boughtPlayers || []), ...(user.currentBids || []).map((bid) => bid.playerId)],
    type: { $in: ["Emerald", "Sapphire"] },
  });
  if (
    ["Emerald", "Sapphire"].includes(player.type) &&
    combinedESCount + esQueued >= combinedESLimit
  ) {
    return {
      ok: false,
      message: `Joining the queue would exceed the combined Emerald + Sapphire limit (${combinedESLimit}). That includes ${esQueued} queued in that group.`,
    };
  }

  const totalOwned = boughtPlayersOfThisType;
  const maxConcurrentBids = TYPE_LIMIT[player.type] - totalOwned;

  if (player.type === "Gold" || player.type === "Silver") {
    if (currentBidPlayersOfThisType + queuedOfThisType >= maxConcurrentBids) {
      return {
        ok: false,
        message: `Joining the queue would exceed how many ${player.type} auctions you can run at once (${maxConcurrentBids}). You have ${currentBidPlayersOfThisType} active bid(s) and ${queuedOfThisType} queued on ${player.type}.`,
      };
    }
  } else if ((user.currentBids || []).length + totalQueued >= 6) {
    return {
      ok: false,
      message:
        "Joining the queue would exceed your concurrent auction limit (including other queue slots). Exit an auction or wait for a queue to clear.",
    };
  }

  return { ok: true };
}

/**
 * Core bid placement (shared by HTTP route and bid queue proxy).
 * @returns {Promise<{ ok: true, newBid: object, bidAmount: number, player: object, user: object } | { ok: false, status: number, message: string }>}
 */
async function placeBidCore({
  playerId,
  bidderId,
  clientIP,
  deviceFingerprint,
  isSuspiciousIP,
  io,
}) {
  try {
    const player = await Player.findById(playerId);
    if (!player) {
      return { ok: false, status: 404, message: "Player not found" };
    }
    if (player.isSold) {
      return { ok: false, status: 400, message: "Cannot place bids on a sold player." };
    }

    const user = await User.findById(bidderId);
    if (!user) {
      return { ok: false, status: 404, message: "User not found." };
    }
    if (user.isLocked) {
      return {
        ok: false,
        status: 403,
        message:
          "You've been locked out for not meeting the minimum/maximum player count by the deadline. " +
          "Please wait until everyone has secured their favorite players. After that window, " +
          "you'll have the chance to join with the remaining players. Hang in there!",
      };
    }

    const typeLimit = TYPE_LIMIT;

    const [boughtPlayersOfThisType, retainedPlayersOfThisType, currentBidPlayersOfThisType] =
      await Promise.all([
        Player.countDocuments({
          _id: { $in: user.boughtPlayers },
          type: player.type,
        }),
        RetainedPlayer.countDocuments({
          userId: user._id,
          playerType: player.type,
          isActive: true,
        }),
        Player.countDocuments({
          _id: { $in: user.currentBids.map((bid) => bid.playerId) },
          type: player.type,
        }),
      ]);

    const totalTypeCount = boughtPlayersOfThisType + currentBidPlayersOfThisType;
    const alreadyBiddingThisPlayer = user.currentBids.some(
      (bid) => bid.playerId.toString() === playerId
    );

    if (totalTypeCount >= typeLimit[player.type] && !alreadyBiddingThisPlayer) {
      return {
        ok: false,
        status: 400,
        message: `You have already reached the maximum limit for ${player.type} players (limit: ${typeLimit[player.type]}). You have ${boughtPlayersOfThisType} bought ${player.type} player(s) (including ${retainedPlayersOfThisType} retained) + ${currentBidPlayersOfThisType} current bids = ${totalTypeCount} total.`,
      };
    }

    const combinedESLimit = 5;
    const combinedESCount = await Player.countDocuments({
      _id: [...user.boughtPlayers, ...user.currentBids.map((bid) => bid.playerId)],
      type: { $in: ["Emerald", "Sapphire"] },
    });

    if (
      ["Emerald", "Sapphire"].includes(player.type) &&
      combinedESCount >= combinedESLimit &&
      !alreadyBiddingThisPlayer
    ) {
      return {
        ok: false,
        status: 400,
        message: `You have reached the maximum combined limit (${combinedESLimit}) for Emerald + Sapphire players.`,
      };
    }

    const activeBids = await Bid.find({ playerId, isActive: true, isBidOn: true })
      .select("bidder bidAmount isActive isBidOn")
      .lean();

    const activeBidders = [...new Set(activeBids.map((bid) => bid.bidder.toString()))];

    if (activeBidders.length >= 2 && !activeBidders.includes(bidderId.toString())) {
      return {
        ok: false,
        status: 400,
        message:
          "Only two bidders can actively bid on a player. Wait for one of the current bidders to exit.",
      };
    }

    if (player.type === "Gold" || player.type === "Silver") {
      const currentBidPlayerIds = user.currentBids.map((bid) => bid.playerId);
      const [playersOfThisTypeInCurrentBids, retainedCount] = await Promise.all([
        Player.countDocuments({
          _id: { $in: currentBidPlayerIds },
          type: player.type,
        }),
        RetainedPlayer.countDocuments({
          userId: user._id,
          playerType: player.type,
          isActive: true,
        }),
      ]);
      const nonRetainedBoughtCount = Math.max(0, boughtPlayersOfThisType - retainedCount);
      const totalOwned = boughtPlayersOfThisType;
      const maxConcurrentBids = typeLimit[player.type] - totalOwned;

      if (playersOfThisTypeInCurrentBids >= maxConcurrentBids && !alreadyBiddingThisPlayer) {
        return {
          ok: false,
          status: 400,
          message: `You can bid on a maximum of ${maxConcurrentBids} ${player.type} players at a time (you have ${retainedCount} retained + ${nonRetainedBoughtCount} bought = ${totalOwned} ${player.type} player${totalOwned !== 1 ? "s" : ""}, so ${totalOwned} + ${maxConcurrentBids} = ${typeLimit[player.type]} total). You currently have ${playersOfThisTypeInCurrentBids} ${player.type} bids. Exit an existing ${player.type} auction to bid on this player.`,
        };
      }
    } else {
      if (user.currentBids.length >= 6 && !alreadyBiddingThisPlayer) {
        return {
          ok: false,
          status: 400,
          message:
            "You can bid on a maximum of 5 players at a time. Exit an existing auction to bid on this player.",
        };
      }
    }

    const highestBid = await Bid.findOne({ playerId, isActive: true })
      .select("bidder bidAmount")
      .sort({ bidAmount: -1 })
      .lean();

    const bidAmount = computeNextBidAmount(player, highestBid);

    const currentBidOnPlayer = user.currentBids.find(
      (bid) => bid.playerId.toString() === playerId
    );
    const lockedAmount = currentBidOnPlayer ? currentBidOnPlayer.amount : 0;
    const incrementalDifference = bidAmount - lockedAmount;

    if (incrementalDifference > 0) {
      const purseValue = parseFloat(user.purse.toString());
      if (purseValue < incrementalDifference) {
        return {
          ok: false,
          status: 400,
          message: `Insufficient funds in purse. You need at least ₹${incrementalDifference} extra to place this bid. Your current purse is ₹${purseValue}.`,
        };
      }
      const updatedPurse = purseValue - incrementalDifference;
      user.purse = mongoose.Types.Decimal128.fromString(updatedPurse.toString());
    }

    if (highestBid && highestBid.bidder.toString() === bidderId.toString()) {
      return {
        ok: false,
        status: 400,
        message: "You cannot place consecutive bids. Wait for another bidder to bid.",
      };
    }

    const newBid = new Bid({
      playerId,
      bidder: bidderId,
      bidAmount,
      isActive: true,
    });
    await newBid.save();

    if (currentBidOnPlayer) {
      currentBidOnPlayer.amount = bidAmount;
    } else {
      user.currentBids.push({ playerId, amount: bidAmount });
    }

    user.lastBidIP = clientIP;
    user.lastBidTime = new Date();
    user.lastDeviceFingerprint = deviceFingerprint;

    if (!user.knownIPs) user.knownIPs = [];
    if (!user.knownIPs.includes(clientIP)) {
      user.knownIPs.push(clientIP);
      if (user.knownIPs.length > 10) user.knownIPs.shift();
    }

    if (!user.knownDevices) user.knownDevices = [];
    if (!user.knownDevices.includes(deviceFingerprint)) {
      user.knownDevices.push(deviceFingerprint);
      if (user.knownDevices.length > 10) user.knownDevices.shift();
    }

    if (isSuspiciousIP) {
      user.suspiciousActivityCount = (user.suspiciousActivityCount || 0) + 1;
    }

    await user.save();

    player.currentBid = bidAmount;
    player.currentBidder = bidderId;
    player.lastBidAt = new Date();
    await player.save();

    let secondBidder = null;
    if (activeBidders.length >= 1) {
      secondBidder = activeBidders.find((id) => id !== bidderId.toString());
    }

    const notificationData = {
      message: "A new bid has been placed",
      playername: player.name,
      currentBid: player.currentBid,
      currentBidder: user.name,
      secondBidder,
      newBid: bidAmount,
      active: true,
    };

    const newNotification = new BidNotification(notificationData);
    await newNotification.save();

    const currentActiveBids = await Bid.find({ playerId, isActive: true, isBidOn: true })
      .select("bidder")
      .lean();
    const currentActiveBidders = [...new Set(currentActiveBids.map((bid) => bid.bidder.toString()))];
    const otherActiveBidders = currentActiveBidders.filter((b) => b !== bidderId.toString());
    const activeBidderSocketIds = getSocketIdsForUsers(otherActiveBidders);

    if (activeBidderSocketIds.length > 0) {
      activeBidderSocketIds.forEach((socketId) => {
        io.to(socketId).emit("bid_notification", notificationData);
      });
    } else {
      io.emit("bid_notification", notificationData);
    }

    invalidateCache("user-purses");
    invalidateCache("players:data");

    io.emit("player_bid_update", {
      playerId: playerId.toString(),
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
      bidderName: user.name,
      bidAmount,
      playerName: player.name,
    });

    return { ok: true, newBid, bidAmount, player, user };
  } catch (err) {
    console.error("placeBidCore error:", err);
    return { ok: false, status: 500, message: "Internal server error" };
  }
}

module.exports = { placeBidCore, assertQueueJoinSlotLimits, countQueuedSlotsForUser };
