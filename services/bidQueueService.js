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
const { placeBidCore, assertQueueJoinSlotLimits } = require("./bidPlacement");
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

/** Broadcast queue depth for player list + popups (includes queueCount for clients). */
async function emitBidQueueUpdated(io, playerId, queueCountKnown) {
  if (!io) return;
  const queueCount =
    typeof queueCountKnown === "number"
      ? queueCountKnown
      : isEnabled()
        ? await countQueued(playerId)
        : 0;
  io.emit("bid_queue_updated", {
    playerId: playerId.toString(),
    queueCount,
  });
}

/** Map playerId string -> number of queued entries (for player board). */
async function getAllQueuedCountsByPlayer() {
  if (!isEnabled()) return {};
  const rows = await BidPlayerQueue.aggregate([
    { $unwind: "$entries" },
    { $match: { "entries.status": "queued" } },
    { $group: { _id: "$playerId", queueCount: { $sum: 1 } } },
  ]);
  const out = {};
  for (const r of rows) {
    if (r._id) out[r._id.toString()] = r.queueCount;
  }
  return out;
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

async function clearQueueForSoldPlayer(playerId, io) {
  return withPlayerBidLock(playerId, async () => {
    const doc = await BidPlayerQueue.findOne({ playerId });
    if (!doc) return { refundedCount: 0, refundedAmount: 0 };

    const player = await Player.findById(playerId).select("name").lean();
    let refundedCount = 0;
    let refundedAmount = 0;

    for (const entry of doc.entries) {
      if (entry.status !== "queued") continue;
      const refund = Number(entry.lockedAmount) || 0;
      await refundPurse(entry.userId, refund);
      refundedCount += 1;
      refundedAmount += refund;
      emitQueuePersonal(io, entry.userId, {
        type: "removed",
        reason: "player_sold",
        playerId: playerId.toString(),
        playerName: player?.name || "",
        refund,
      });
    }

    await BidPlayerQueue.deleteOne({ _id: doc._id });
    await emitBidQueueUpdated(io, playerId, 0);
    return { refundedCount, refundedAmount };
  });
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
  await emitBidQueueUpdated(io, playerId);
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
  await emitBidQueueUpdated(io, playerId);
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
      if (!res.ok) {
        doc.entries.pull(entry._id);
        await doc.save();
        await forceExitProxyUser(proxyUserId, playerId, io);
        outcome = "promote";
        return;
      }
      outcome = "bid";
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

      await emitBidQueueUpdated(io, playerId);
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

async function triggerProxyAfterOpponentBid(playerId, io) {
  if (!isEnabled()) return;
  const doc = await BidPlayerQueue.findOne({ playerId }).select("entries").lean();
  if (!doc?.entries?.length) return;
  const proxy = doc.entries.find((e) => e.status === "active_proxy");
  if (!proxy) return;
  const proxyUserId = proxy.userId.toString();
  await runProxyContinuation(playerId, proxyUserId, io);
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

    const slotCheck = await assertQueueJoinSlotLimits(userId, playerId);
    if (!slotCheck.ok) {
      return { ok: false, status: 400, message: slotCheck.message };
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
    const qn = doc.entries.filter((e) => e.status === "queued").length;
    await emitBidQueueUpdated(io, playerId, qn);

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
    return {
      ok: false,
      status: 403,
      message:
        "You cannot leave the bid queue before you are promoted into the auction. Wait until your auto-bid starts, then use Exit if you need to stop.",
    };
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

    await emitBidQueueUpdated(io, playerId);
    return { ok: true };
  });
}

/**
 * All queue / proxy rows for this user (for auction hub).
 */
async function listMyQueueMemberships(userId) {
  const uid = userId.toString();
  const docs = await BidPlayerQueue.find({ "entries.userId": userId })
    .populate("playerId", "name type profilePicture")
    .lean();

  const out = [];
  for (const doc of docs) {
    if (!doc?.playerId) continue;
    const queued = doc.entries
      .filter((e) => e.status === "queued")
      .sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
    const mine = doc.entries.find(
      (e) => e.userId.toString() === uid && (e.status === "queued" || e.status === "active_proxy")
    );
    if (!mine) continue;

    const idx = queued.findIndex((e) => e.userId.toString() === uid);
    const position = mine.status === "queued" && idx >= 0 ? idx + 1 : null;
    const aheadCount = mine.status === "queued" && idx >= 0 ? idx : null;
    const behindCount =
      mine.status === "queued" && idx >= 0 ? Math.max(0, queued.length - idx - 1) : null;

    out.push({
      playerId: doc.playerId._id?.toString() || doc.playerId.toString(),
      playerName: doc.playerId.name || "?",
      playerType: doc.playerId.type || "",
      profilePicture: doc.playerId.profilePicture || null,
      position,
      aheadCount,
      behindCount,
      queueLength: queued.length,
      maxBid: mine.maxBid,
      status: mine.status,
      maxEditTradesRemaining: mine.maxEditTradesRemaining,
      label: mine.status === "active_proxy" ? "Auto-bidding (queue)" : `Queue #${position} of ${queued.length}`,
    });
  }
  return out;
}

async function getQueueState(playerId, viewerUserId) {
  const activeBidderIds = await getActiveBidderIds(playerId);
  const activeBidderCount = activeBidderIds.length;
  const queueJoinAllowed = activeBidderCount === 2;

  const viewerStr = viewerUserId ? viewerUserId.toString() : null;
  const viewerIsActiveBidder = viewerStr ? activeBidderIds.includes(viewerStr) : false;

  if (!isEnabled()) {
    return {
      enabled: false,
      manualBidsFrozen: false,
      queueCount: 0,
      you: null,
      queueJoinAllowed: false,
      canJoinQueue: false,
      activeBidderCount,
    };
  }
  const doc = await BidPlayerQueue.findOne({ playerId })
    .populate("entries.userId", "name teamName")
    .lean();
  const queuedRaw = doc?.entries.filter((e) => e.status === "queued") || [];
  const queued = [...queuedRaw].sort(
    (a, b) => new Date(a.joinedAt) - new Date(b.joinedAt)
  );
  const queueCount = queued.length;
  const manualBidsFrozen = queueCount > 0;
  const youQueued = viewerUserId
    ? queued.find((e) => e.userId._id.toString() === viewerUserId.toString()) || null
    : null;
  const proxyYou = viewerUserId
    ? doc?.entries.find(
        (e) =>
          e.userId._id.toString() === viewerUserId.toString() && e.status === "active_proxy"
      ) || null
    : null;

  const viewerDisplayName = (u) => {
    if (!u || typeof u !== "object") return null;
    return u.name || u.teamName || null;
  };

  let you = null;
  if (youQueued) {
    const idx = queued.findIndex((e) => e.userId._id.toString() === viewerUserId.toString());
    const position = idx >= 0 ? idx + 1 : null;
    you = {
      maxBid: youQueued.maxBid,
      maxEditTradesRemaining: youQueued.maxEditTradesRemaining,
      isPromotedProxy: false,
      displayName: viewerDisplayName(youQueued.userId),
      teamName: youQueued.userId?.teamName || null,
      position,
      queueLength: queueCount,
    };
  } else if (proxyYou) {
    you = {
      maxBid: proxyYou.maxBid,
      maxEditTradesRemaining: proxyYou.maxEditTradesRemaining,
      isPromotedProxy: true,
      displayName: viewerDisplayName(proxyYou.userId),
      teamName: proxyYou.userId?.teamName || null,
    };
  }

  const canJoinQueue =
    queueJoinAllowed &&
    !!viewerStr &&
    !viewerIsActiveBidder &&
    !you;

  return {
    enabled: true,
    manualBidsFrozen,
    queueCount,
    queueJoinAllowed,
    canJoinQueue,
    activeBidderCount,
    you,
  };
}

async function isPromotedProxyBidder(playerId, userId) {
  if (!isEnabled()) return false;
  const doc = await BidPlayerQueue.findOne({ playerId }).select("entries").lean();
  if (!doc?.entries?.length) return false;
  const uid = userId.toString();
  return doc.entries.some(
    (e) => e.userId.toString() === uid && e.status === "active_proxy"
  );
}

/**
 * Promoted (active_proxy) user stays in the auction but stops auto-bid; manual Place Bid allowed again.
 * To use auto-bid later they must exit, join queue again, and get promoted.
 */
async function resignActiveProxyToManual({ playerId, userId, io }) {
  if (!isEnabled()) {
    return { ok: false, status: 503, message: "Bid queue feature is disabled." };
  }
  return withPlayerBidLock(playerId, async () => {
    const doc = await BidPlayerQueue.findOne({ playerId });
    if (!doc) {
      return { ok: false, status: 404, message: "No queue for this player." };
    }
    const entry = doc.entries.find(
      (e) => e.userId.toString() === userId.toString() && e.status === "active_proxy"
    );
    if (!entry) {
      return {
        ok: false,
        status: 400,
        message: "You are not in auto-bid (queue promotion) mode on this player.",
      };
    }
    const activeBid = await Bid.findOne({
      playerId,
      bidder: userId,
      isActive: true,
      isBidOn: true,
    }).lean();
    if (!activeBid) {
      return {
        ok: false,
        status: 400,
        message: "No active bid on this player; nothing to switch to manual.",
      };
    }

    doc.entries.pull(entry._id);
    if (!doc.entries.length) {
      await BidPlayerQueue.deleteOne({ _id: doc._id });
    } else {
      await doc.save();
    }

    emitQueuePersonal(io, userId, {
      type: "proxy_resigned_manual",
      playerId: playerId.toString(),
    });
    await emitBidQueueUpdated(io, playerId);
    return { ok: true };
  });
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
  await emitBidQueueUpdated(io, playerId);
}

module.exports = {
  isEnabled,
  shouldBlockManualBid,
  countQueued,
  getAllQueuedCountsByPlayer,
  getActiveBidderIds,
  pruneQueuedOverMax,
  tryPromoteNextQueued,
  triggerProxyAfterOpponentBid,
  enqueueUser,
  leaveQueue,
  updateQueueMax,
  getQueueState,
  listMyQueueMemberships,
  clearQueueForSoldPlayer,
  isPromotedProxyBidder,
  resignActiveProxyToManual,
  afterBidPlaced,
  runProxyContinuation,
};
