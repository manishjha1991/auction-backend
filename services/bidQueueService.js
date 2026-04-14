const mongoose = require("mongoose");
const BidPlayerQueue = require("../models/BidPlayerQueue");
const User = require("../models/User");
const Player = require("../models/Player");
const Bid = require("../models/Bid");
const {
  computeNextBidAmount,
  countBidStepsUntilExceedingMax,
} = require("../utils/bidIncrement");
const { withPlayerBidLock } = require("../utils/bidQueueMutex");
const { placeBidCore } = require("./bidPlacement");
const { getSocketIdsForUsers } = require("../utils/socketUserMap");

const PROXY_FINGERPRINT = "bid-queue-proxy";
const PROXY_IP = "127.0.0.1";

function isEnabled() {
  return process.env.ENABLE_BID_QUEUE === "true";
}

async function getOrCreateDoc(playerId) {
  let doc = await BidPlayerQueue.findOne({ playerId });
  if (!doc) {
    doc = new BidPlayerQueue({ playerId, entries: [] });
    await doc.save();
  }
  return doc;
}

async function getActiveBidderIds(playerId) {
  const bids = await Bid.find({ playerId, isActive: true, isBidOn: true })
    .select("bidder")
    .lean();
  return [...new Set(bids.map((b) => b.bidder.toString()))];
}

async function countQueued(playerId) {
  const doc = await BidPlayerQueue.findOne({ playerId }).select("entries").lean();
  if (!doc) return 0;
  return doc.entries.filter((e) => e.status === "queued").length;
}

async function shouldBlockManualBid(playerId, bidderId) {
  if (!isEnabled()) return false;
  const n = await countQueued(playerId);
  if (n === 0) return false;
  const active = await getActiveBidderIds(playerId);
  return !active.includes(bidderId.toString());
}

async function refundPurse(userId, amount) {
  if (amount <= 0) return;
  const user = await User.findById(userId);
  if (!user) return;
  const p = parseFloat(user.purse.toString()) + amount;
  user.purse = mongoose.Types.Decimal128.fromString(String(p));
  await user.save();
}

function emitQueuePersonal(io, userId, payload) {
  if (!io) return;
  const ids = getSocketIdsForUsers([userId.toString()]);
  ids.forEach((sid) => io.to(sid).emit("bid_queue_personal", payload));
}

async function removeQueuedEntryById(playerId, subdocId, reason, io) {
  const doc = await BidPlayerQueue.findOne({ playerId });
  if (!doc) return;
  const entry = doc.entries.id(subdocId);
  if (!entry || entry.status !== "queued") return;
  const refund = entry.lockedAmount;
  const userId = entry.userId;
  const player = await Player.findById(playerId).select("name").lean();
  doc.entries.pull(subdocId);
  await doc.save();
  await refundPurse(userId, refund);
  emitQueuePersonal(io, userId, {
    type: "removed",
    reason,
    playerId: playerId.toString(),
    playerName: player?.name || "",
    refund,
  });
  io?.emit("bid_queue_updated", { playerId: playerId.toString() });
}

async function pruneQueuedOverMax(playerId, io) {
  if (!isEnabled()) return;
  await withPlayerBidLock(playerId, async () => {
    const player = await Player.findById(playerId);
    if (!player) return;

    const highestBid = await Bid.findOne({ playerId, isActive: true })
      .sort({ bidAmount: -1 })
      .select("bidAmount")
      .lean();

    const nextBid = computeNextBidAmount(player, highestBid);

    const doc = await BidPlayerQueue.findOne({ playerId });
    if (!doc) return;

    const toPull = [];
    for (const e of doc.entries) {
      if (e.status !== "queued") continue;
      if (nextBid > e.maxBid) {
        toPull.push(e._id);
      }
    }
    for (const id of toPull) {
      await removeQueuedEntryById(playerId, id, "price_exceeded", io);
    }
  });
}

async function preparePromotedUser(userId, playerId, queueEntry, nextBidAmount) {
  const user = await User.findById(userId);
  const M = queueEntry.lockedAmount;
  const refund = M - nextBidAmount;
  const purse = parseFloat(user.purse.toString()) + refund;
  user.purse = mongoose.Types.Decimal128.fromString(String(purse));
  const ex = user.currentBids.find((b) => b.playerId.toString() === playerId);
  if (ex) ex.amount = nextBidAmount;
  else user.currentBids.push({ playerId, amount: nextBidAmount });
  await user.save();
}

async function revertPreparePromotedUser(userId, playerId, nextBidAmount, lockedMax) {
  const user = await User.findById(userId);
  const undoRefund = lockedMax - nextBidAmount;
  const p = parseFloat(user.purse.toString()) - undoRefund;
  user.purse = mongoose.Types.Decimal128.fromString(String(p));
  user.currentBids = user.currentBids.filter((b) => b.playerId.toString() !== playerId);
  await user.save();
}

async function forceExitProxyUser(userId, playerId, io) {
  const user = await User.findById(userId);
  if (!user) return;
  const bidOnPlayer = user.currentBids.find((b) => b.playerId.toString() === playerId);
  const locked = bidOnPlayer ? bidOnPlayer.amount : 0;
  if (locked > 0) {
    const p = parseFloat(user.purse.toString()) + locked;
    user.purse = mongoose.Types.Decimal128.fromString(String(p));
  }
  user.currentBids = user.currentBids.filter((b) => b.playerId.toString() !== playerId);
  await user.save();
  await Bid.updateMany(
    { playerId, bidder: userId },
    { $set: { isActive: false, isBidOn: false } }
  );

  const player = await Player.findById(playerId);
  const remaining = await Bid.find({ playerId, isActive: true, isBidOn: true })
    .sort({ bidAmount: -1 })
    .lean();
  if (remaining.length) {
    player.currentBid = remaining[0].bidAmount;
    player.currentBidder = remaining[0].bidder;
  } else {
    player.currentBid = null;
    player.currentBidder = null;
  }
  await player.save();

  emitQueuePersonal(io, userId, {
    type: "proxy_exited_max",
    playerId: playerId.toString(),
    playerName: player.name,
  });
  io?.emit("player_bid_update", {
    playerId: playerId.toString(),
    currentBid: player.currentBid,
    currentBidder: player.currentBidder,
    playerName: player.name,
  });
  io?.emit("bid_queue_updated", { playerId: playerId.toString() });
}

async function runProxyContinuation(playerId, proxyUserId, io) {
  for (let i = 0; i < 40; i++) {
    let outcome = "stop";
    await withPlayerBidLock(playerId, async () => {
      const doc = await BidPlayerQueue.findOne({ playerId });
      const entry = doc?.entries.find(
        (e) => e.userId.toString() === proxyUserId.toString() && e.status === "active_proxy"
      );
      if (!entry) {
        outcome = "stop";
        return;
      }

      const player = await Player.findById(playerId);
      const highest = await Bid.findOne({ playerId, isActive: true })
        .sort({ bidAmount: -1 })
        .lean();
      if (!highest) {
        outcome = "stop";
        return;
      }

      if (highest.bidder.toString() === proxyUserId.toString()) {
        outcome = "stop";
        return;
      }

      const nextBid = computeNextBidAmount(player, highest);
      if (nextBid > entry.maxBid) {
        doc.entries.pull(entry._id);
        await doc.save();
        await forceExitProxyUser(proxyUserId, playerId, io);
        outcome = "promote";
        return;
      }

      const res = await placeBidCore({
        playerId,
        bidderId: proxyUserId,
        clientIP: PROXY_IP,
        deviceFingerprint: PROXY_FINGERPRINT,
        isSuspiciousIP: false,
        io,
      });
      outcome = res.ok ? "bid" : "stop";
    });

    await afterBidPlaced(playerId, io);

    if (outcome === "stop") return;
    if (outcome === "promote") {
      await tryPromoteNextQueued(playerId, io);
      return;
    }
  }
}

async function tryPromoteNextQueued(playerId, io) {
  if (!isEnabled()) return;

  let proxyUserId = null;

  await withPlayerBidLock(playerId, async () => {
    const activeBidders = await getActiveBidderIds(playerId);
    if (activeBidders.length !== 1) return;

    const player = await Player.findById(playerId);
    if (!player || player.isSold) return;

    /* eslint-disable no-await-in-loop */
    while (true) {
      const doc = await BidPlayerQueue.findOne({ playerId });
      if (!doc) return;

      const head = doc.entries.find((e) => e.status === "queued");
      if (!head) return;

      const highestBid = await Bid.findOne({ playerId, isActive: true })
        .sort({ bidAmount: -1 })
        .lean();

      const nextBid = computeNextBidAmount(player, highestBid);
      if (nextBid > head.maxBid) {
        await removeQueuedEntryById(playerId, head._id, "price_exceeded", io);
        continue;
      }

      const headEntry = doc.entries.id(head._id);
      const lockedSnapshot = head.lockedAmount;

      await preparePromotedUser(head.userId, playerId, head, nextBid);
      headEntry.status = "active_proxy";
      await doc.save();

      const res = await placeBidCore({
        playerId,
        bidderId: head.userId,
        clientIP: PROXY_IP,
        deviceFingerprint: PROXY_FINGERPRINT,
        isSuspiciousIP: false,
        io,
      });

      if (!res.ok) {
        await revertPreparePromotedUser(head.userId, playerId, nextBid, lockedSnapshot);
        headEntry.status = "queued";
        await doc.save();
        return;
      }

      io?.emit("bid_queue_updated", { playerId: playerId.toString() });
      emitQueuePersonal(io, head.userId, {
        type: "promoted",
        playerId: playerId.toString(),
        playerName: player.name,
      });

      proxyUserId = head.userId.toString();
      break;
    }
    /* eslint-enable no-await-in-loop */
  });

  if (proxyUserId) {
    await afterBidPlaced(playerId, io);
    await runProxyContinuation(playerId, proxyUserId, io);
  }
}

async function enqueueUser({ playerId, userId, maxBid, io }) {
  if (!isEnabled()) {
    return { ok: false, status: 503, message: "Bid queue feature is disabled." };
  }
  return withPlayerBidLock(playerId, async () => {
    const player = await Player.findById(playerId);
    if (!player || player.isSold) {
      return { ok: false, status: 404, message: "Player not found or sold." };
    }

    const user = await User.findById(userId);
    if (!user || user.isLocked) {
      return { ok: false, status: 403, message: "Cannot join queue." };
    }

    const activeBidders = await getActiveBidderIds(playerId);
    if (activeBidders.length !== 2) {
      return {
        ok: false,
        status: 400,
        message:
          "The bid queue is only available when exactly two bidders are active on this player. Wait until both have joined the auction, then try again.",
      };
    }
    if (activeBidders.includes(userId.toString())) {
      return {
        ok: false,
        status: 400,
        message: "You are already in this auction. Use Place Bid — the queue is for other teams waiting to enter.",
      };
    }

    const doc = await getOrCreateDoc(playerId);
    if (doc.entries.some((e) => e.userId.toString() === userId && e.status === "queued")) {
      return { ok: false, status: 400, message: "You are already in the queue for this player." };
    }

    const highestBid = await Bid.findOne({ playerId, isActive: true })
      .sort({ bidAmount: -1 })
      .lean();
    const nextBid = computeNextBidAmount(player, highestBid);
    if (maxBid < nextBid) {
      return {
        ok: false,
        status: 400,
        message: `Max bid must be at least the next bid amount (Rs ${nextBid}).`,
      };
    }

    const purse = parseFloat(user.purse.toString());
    if (purse < maxBid) {
      return { ok: false, status: 400, message: "Insufficient purse to lock your max bid." };
    }

    user.purse = mongoose.Types.Decimal128.fromString(String(purse - maxBid));
    await user.save();

    doc.entries.push({
      userId,
      maxBid,
      status: "queued",
      lockedAmount: maxBid,
      joinedAt: new Date(),
      maxEditTradesRemaining: null,
    });
    await doc.save();

    emitQueuePersonal(io, userId, {
      type: "joined",
      playerId: playerId.toString(),
      playerName: player.name,
      maxBid,
    });
    io?.emit("bid_queue_updated", { playerId: playerId.toString() });

    const qn = doc.entries.filter((e) => e.status === "queued").length;
    return { ok: true, queueCount: qn };
  });
}

async function leaveQueue({ playerId, userId, io }) {
  if (!isEnabled()) {
    return { ok: false, status: 503, message: "Bid queue feature is disabled." };
  }
  return withPlayerBidLock(playerId, async () => {
    const doc = await BidPlayerQueue.findOne({ playerId });
    if (!doc) {
      return { ok: false, status: 404, message: "No queue for this player." };
    }
    const entry = doc.entries.find(
      (e) => e.userId.toString() === userId && e.status === "queued"
    );
    if (!entry) {
      return { ok: false, status: 400, message: "You are not in the queue." };
    }
    await removeQueuedEntryById(playerId, entry._id, "left", io);
    return { ok: true };
  });
}

async function updateQueueMax({ playerId, userId, maxBid, io }) {
  if (!isEnabled()) {
    return { ok: false, status: 503, message: "Bid queue feature is disabled." };
  }
  return withPlayerBidLock(playerId, async () => {
    const doc = await BidPlayerQueue.findOne({ playerId });
    if (!doc) return { ok: false, status: 404, message: "No queue." };
    const entry = doc.entries.find((e) => e.userId.toString() === userId && e.status === "queued");
    if (!entry) {
      return { ok: false, status: 400, message: "Not in queue or not editable." };
    }

    const player = await Player.findById(playerId);
    const highestBid = await Bid.findOne({ playerId, isActive: true })
      .sort({ bidAmount: -1 })
      .lean();
    const nextBid = computeNextBidAmount(player, highestBid);
    if (maxBid < nextBid) {
      return { ok: false, status: 400, message: `Max must be at least next bid Rs ${nextBid}.` };
    }

    const delta = maxBid - entry.maxBid;
    const user = await User.findById(userId);
    const purse = parseFloat(user.purse.toString());
    if (delta > 0 && purse < delta) {
      return { ok: false, status: 400, message: "Insufficient purse to raise max." };
    }

    if (entry.maxEditTradesRemaining !== null && entry.maxEditTradesRemaining <= 0 && delta > 0) {
      return {
        ok: false,
        status: 400,
        message: "Max cannot be raised: edit window expired (3 bid steps).",
      };
    }

    user.purse = mongoose.Types.Decimal128.fromString(String(purse - delta));
    entry.maxBid = maxBid;
    entry.lockedAmount += delta;
    await user.save();
    await doc.save();

    io?.emit("bid_queue_updated", { playerId: playerId.toString() });
    return { ok: true };
  });
}

async function getQueueState(playerId, viewerUserId) {
  const activeBidderIds = await getActiveBidderIds(playerId);
  const activeBidderCount = activeBidderIds.length;
  const queueJoinAllowed = activeBidderCount === 2;

  if (!isEnabled()) {
    return {
      enabled: false,
      manualBidsFrozen: false,
      queueCount: 0,
      you: null,
      queueJoinAllowed: false,
      activeBidderCount,
    };
  }
  const doc = await BidPlayerQueue.findOne({ playerId })
    .populate("entries.userId", "name teamName")
    .lean();
  const queued = doc?.entries.filter((e) => e.status === "queued") || [];
  const manualBidsFrozen = queued.length > 0;
  const you = viewerUserId
    ? queued.find((e) => e.userId._id.toString() === viewerUserId.toString()) || null
    : null;
  return {
    enabled: true,
    manualBidsFrozen,
    queueCount: queued.length,
    queueJoinAllowed,
    activeBidderCount,
    you: you
      ? {
          maxBid: you.maxBid,
          maxEditTradesRemaining: you.maxEditTradesRemaining,
        }
      : null,
  };
}

async function afterBidPlaced(playerId, io) {
  if (!isEnabled()) return;
  await pruneQueuedOverMax(playerId, io);

  const doc = await BidPlayerQueue.findOne({ playerId });
  if (!doc) return;
  const player = await Player.findById(playerId);
  const highestBid = await Bid.findOne({ playerId, isActive: true })
    .sort({ bidAmount: -1 })
    .lean();

  let changed = false;
  for (const e of doc.entries) {
    if (e.status !== "queued") continue;
    const steps = countBidStepsUntilExceedingMax(player, highestBid, e.maxBid);
    if (steps <= 3 && e.maxEditTradesRemaining === null) {
      e.maxEditTradesRemaining = 3;
      changed = true;
    }
    if (e.maxEditTradesRemaining !== null && e.maxEditTradesRemaining > 0) {
      e.maxEditTradesRemaining -= 1;
      changed = true;
    }
  }
  if (changed) await doc.save();
  io?.emit("bid_queue_updated", { playerId: playerId.toString() });
}

module.exports = {
  isEnabled,
  shouldBlockManualBid,
  countQueued,
  getActiveBidderIds,
  pruneQueuedOverMax,
  tryPromoteNextQueued,
  enqueueUser,
  leaveQueue,
  updateQueueMax,
  getQueueState,
  afterBidPlaced,
  runProxyContinuation,
};
