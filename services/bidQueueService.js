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
const MIN_QUEUE_BID_STEPS = 4;

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

/**
 * Self-heal stale queue state:
 * if a user is already an active bidder on this player but still marked "queued",
 * promote that row to "active_proxy" so auto-bid continuation can run.
 */
async function reconcileQueuedActiveBidders(playerId) {
  if (!isEnabled()) return false;
  let changed = false;
  await withPlayerBidLock(playerId, async () => {
    const doc = await BidPlayerQueue.findOne({ playerId });
    if (!doc?.entries?.length) return;
    const active = new Set(await getActiveBidderIds(playerId));
    for (const e of doc.entries) {
      if (e.status === "queued" && active.has(e.userId.toString())) {
        e.status = "active_proxy";
        changed = true;
      } else if (e.status === "active_proxy" && !active.has(e.userId.toString())) {
        // Repair stale proxy rows (e.g. failed promotion or prior inconsistency).
        e.status = "queued";
        changed = true;
      }
    }
    if (changed) {
      await doc.save();
    }
  });
  return changed;
}

function getNthNextLegalBid(player, highestBid, n) {
  let cursor = highestBid || null;
  let target = player.basePrice;
  for (let i = 0; i < n; i += 1) {
    target = computeNextBidAmount(player, cursor);
    cursor = { bidAmount: target };
  }
  return target;
}

function assessQueueMaxBid(player, highestBid, maxBid) {
  const nextBid = computeNextBidAmount(player, highestBid || null);
  const currentTop = highestBid?.bidAmount ?? player.basePrice;
  const minAllowedMax = getNthNextLegalBid(player, highestBid || null, MIN_QUEUE_BID_STEPS);

  // Walk legal ladder to see if maxBid is exactly on a valid bid step.
  let cursor = highestBid || null;
  let legalStepsCovered = 0;
  let isExactLegalStep = false;
  let nearestLowerLegal = currentTop;
  let nearestHigherLegal = nextBid;

  for (let i = 0; i < 500; i += 1) {
    const next = computeNextBidAmount(player, cursor);
    nearestHigherLegal = next;
    if (next > maxBid) break;
    legalStepsCovered += 1;
    nearestLowerLegal = next;
    if (next === maxBid) {
      isExactLegalStep = true;
      break;
    }
    cursor = { bidAmount: next };
  }

  return {
    nextBid,
    currentTop,
    minAllowedMax,
    legalStepsCovered,
    isExactLegalStep,
    nearestLowerLegal,
    nearestHigherLegal,
  };
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
  const [active, doc] = await Promise.all([
    getActiveBidderIds(playerId),
    BidPlayerQueue.findOne({ playerId }).select("entries.status").lean(),
  ]);
  const activeCount = active.length;
  const isActiveBidder = active.includes(bidderId.toString());
  if (isActiveBidder) return false;

  const queueCount =
    doc?.entries?.reduce((acc, e) => (e.status === "queued" ? acc + 1 : acc), 0) || 0;
  const hasActiveProxy = !!doc?.entries?.some((e) => e.status === "active_proxy");

  // Block third-party manual bids while queue exists, and while a promoted queue proxy
  // is still in an active 2-bidder duel.
  if (queueCount > 0) return true;
  if (hasActiveProxy && activeCount >= 2) return true;
  return false;
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
  await emitBidQueueUpdated(io, playerId);
}

async function pruneQueuedOverMax(playerId, io) {
  if (!isEnabled()) return;
  await withPlayerBidLock(playerId, async () => {
    const player = await Player.findById(playerId);
    if (!player) return;

    const highestBid = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
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

async function runProxyContinuation(playerId, proxyUserId, io, options = {}) {
  const fanout = options.fanout !== false;
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
      const highest = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
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
        allowLockedForProxy: true,
      });
      if (!res.ok) {
        const msg = String(res.message || "").toLowerCase();
        const nonFatal =
          (typeof res.status === "number" && res.status >= 500) ||
          msg.includes("consecutive bids") ||
          msg.includes("only two bidders");
        if (nonFatal) {
          // Keep proxy active; next state change will re-trigger continuation.
          outcome = "stop";
          return;
        }

        doc.entries.pull(entry._id);
        await doc.save();
        await forceExitProxyUser(proxyUserId, playerId, io);
        outcome = "promote";
        return;
      }
      outcome = "bid";
    });

    await afterBidPlaced(playerId, io);
    if (outcome === "bid" && fanout) {
      await triggerProxyAfterOpponentBid(playerId, io, proxyUserId);
    }

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

      const highestBid = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
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
        allowLockedForProxy: true,
      });

      if (!res.ok) {
        await revertPreparePromotedUser(head.userId, playerId, nextBid, lockedSnapshot);
        const msg = String(res.message || "").toLowerCase();
        const permanentlyIneligible =
          res.status === 404 ||
          (res.status === 403 && msg.includes("locked out")) ||
          (res.status === 400 &&
            (msg.includes("maximum limit") ||
              msg.includes("maximum combined limit") ||
              msg.includes("maximum of") ||
              msg.includes("can bid on a maximum")));

        if (permanentlyIneligible) {
          // Head user can no longer be promoted; remove and continue queue.
          headEntry.status = "queued";
          await doc.save();
          await removeQueuedEntryById(playerId, head._id, "ineligible_for_promotion", io);
          continue;
        }

        // Temporary/unknown error: keep position and retry on next trigger.
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

async function triggerProxyAfterOpponentBid(playerId, io, excludeUserId = null) {
  if (!isEnabled()) return;
  await reconcileQueuedActiveBidders(playerId);
  let excluded = excludeUserId ? excludeUserId.toString() : null;

  // Iterate until bidding stabilizes so proxy-vs-proxy duels keep responding
  // automatically (or until safety cap is reached).
  for (let round = 0; round < 200; round += 1) {
    const doc = await BidPlayerQueue.findOne({ playerId }).select("entries").lean();
    if (!doc?.entries?.length) return;

    const proxyUserIds = [
      ...new Set(
        doc.entries
          .filter((e) => e.status === "active_proxy")
          .map((e) => e.userId.toString())
          .filter((uid) => !excluded || uid !== excluded)
      ),
    ];
    if (!proxyUserIds.length) return;

    const beforeTop = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
      .sort({ bidAmount: -1 })
      .select("bidder bidAmount")
      .lean();

    for (const proxyUserId of proxyUserIds) {
      await runProxyContinuation(playerId, proxyUserId, io, { fanout: false });
    }

    const afterTop = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
      .sort({ bidAmount: -1 })
      .select("bidder bidAmount")
      .lean();

    const changed =
      (beforeTop?.bidder?.toString?.() || null) !== (afterTop?.bidder?.toString?.() || null) ||
      (beforeTop?.bidAmount ?? null) !== (afterTop?.bidAmount ?? null);

    if (!changed) return;

    // Exclude initiator only in first round to prevent immediate bounceback;
    // then allow all active proxies to participate.
    excluded = null;
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

    const highestBid = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
      .sort({ bidAmount: -1 })
      .lean();
    const maxAssessment = assessQueueMaxBid(player, highestBid, maxBid);
    if (maxBid < maxAssessment.nextBid) {
      return {
        ok: false,
        status: 400,
        message: `Queue join blocked: your max bid (Rs ${maxBid}) is below required level. Current top is Rs ${maxAssessment.currentTop} and next legal bid is Rs ${maxAssessment.nextBid}. Set max >= Rs ${maxAssessment.nextBid}.`,
      };
    }
    if (!maxAssessment.isExactLegalStep) {
      return {
        ok: false,
        status: 400,
        message: `Queue join blocked: max bid must match legal bid ladder. Nearest valid bids are Rs ${maxAssessment.nearestLowerLegal} or Rs ${maxAssessment.nearestHigherLegal}.`,
      };
    }
    if (maxAssessment.legalStepsCovered < MIN_QUEUE_BID_STEPS) {
      return {
        ok: false,
        status: 400,
        message: `Queue join blocked: max bid must cover at least next ${MIN_QUEUE_BID_STEPS} legal bid steps. Current top is Rs ${maxAssessment.currentTop}, so minimum allowed max is Rs ${maxAssessment.minAllowedMax}.`,
      };
    }

    const purse = parseFloat(user.purse.toString());
    if (purse < maxBid) {
      return {
        ok: false,
        status: 400,
        message: `Queue join blocked: insufficient purse. Available purse is Rs ${purse}, but queue max lock requested is Rs ${maxBid}. Reduce max bid or increase purse.`,
      };
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
    const highestBid = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
      .sort({ bidAmount: -1 })
      .lean();
    const maxAssessment = assessQueueMaxBid(player, highestBid, maxBid);
    if (maxBid < maxAssessment.nextBid) {
      return {
        ok: false,
        status: 400,
        message: `Max update blocked: your max bid (Rs ${maxBid}) is below next legal bid Rs ${maxAssessment.nextBid}.`,
      };
    }
    if (!maxAssessment.isExactLegalStep) {
      return {
        ok: false,
        status: 400,
        message: `Max update blocked: value must match legal bid ladder. Nearest valid bids are Rs ${maxAssessment.nearestLowerLegal} or Rs ${maxAssessment.nearestHigherLegal}.`,
      };
    }
    if (maxAssessment.legalStepsCovered < MIN_QUEUE_BID_STEPS) {
      return {
        ok: false,
        status: 400,
        message: `Max update blocked: keep at least next ${MIN_QUEUE_BID_STEPS} legal bid steps buffer. Current top is Rs ${maxAssessment.currentTop}; minimum allowed max is Rs ${maxAssessment.minAllowedMax}.`,
      };
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

/**
 * Admin queue monitor snapshot:
 * - all players that currently have queued/proxy entries
 * - queued users with max bids + position
 * - active proxy user (if any)
 * - current top active bid + bidder
 */
async function getAdminQueueOverview() {
  const docs = await BidPlayerQueue.find({
    entries: { $elemMatch: { status: { $in: ["queued", "active_proxy"] } } },
  })
    .populate("playerId", "name type profilePicture currentBid currentBidder isSold isActive")
    .populate("entries.userId", "name teamName")
    .lean();

  const playerIds = docs
    .map((d) => d.playerId?._id)
    .filter(Boolean);

  const topBidsRaw = playerIds.length
    ? await Bid.find({
        playerId: { $in: playerIds },
        isActive: true,
        isBidOn: true,
      })
        .sort({ playerId: 1, bidAmount: -1 })
        .populate("bidder", "name teamName")
        .lean()
    : [];

  const topBidByPlayer = new Map();
  for (const bid of topBidsRaw) {
    const pid = bid.playerId?.toString?.();
    if (!pid || topBidByPlayer.has(pid)) continue;
    topBidByPlayer.set(pid, bid);
  }

  const out = [];
  for (const doc of docs) {
    const player = doc.playerId;
    if (!player) continue;

    const queued = (doc.entries || [])
      .filter((e) => e.status === "queued")
      .sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt))
      .map((e, idx) => ({
        userId: e.userId?._id?.toString?.() || e.userId?.toString?.() || null,
        name: e.userId?.name || "Unknown",
        teamName: e.userId?.teamName || "",
        maxBid: e.maxBid,
        lockedAmount: e.lockedAmount,
        joinedAt: e.joinedAt,
        position: idx + 1,
      }));

    const activeProxy = (doc.entries || []).find((e) => e.status === "active_proxy");
    const topActive = topBidByPlayer.get(player._id.toString()) || null;

    out.push({
      playerId: player._id.toString(),
      playerName: player.name || "?",
      playerType: player.type || "",
      profilePicture: player.profilePicture || null,
      isSold: !!player.isSold,
      isActive: player.isActive !== false,
      queueCount: queued.length,
      queued,
      activeProxy: activeProxy
        ? {
            userId: activeProxy.userId?._id?.toString?.() || activeProxy.userId?.toString?.() || null,
            name: activeProxy.userId?.name || "Unknown",
            teamName: activeProxy.userId?.teamName || "",
            maxBid: activeProxy.maxBid,
          }
        : null,
      topActiveBid: topActive
        ? {
            amount: topActive.bidAmount,
            bidderId: topActive.bidder?._id?.toString?.() || topActive.bidder?.toString?.() || null,
            bidderName: topActive.bidder?.name || "",
            bidderTeam: topActive.bidder?.teamName || "",
          }
        : null,
      updatedAt: doc.updatedAt,
    });
  }

  out.sort((a, b) => {
    if (b.queueCount !== a.queueCount) return b.queueCount - a.queueCount;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return out;
}

async function getQueueState(playerId, viewerUserId) {
  await reconcileQueuedActiveBidders(playerId);
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
  const hasActiveProxy = !!doc?.entries?.some((e) => e.status === "active_proxy");
  const manualBidsFrozen = queueCount > 0 || (hasActiveProxy && activeBidderCount >= 2);
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
  const highestBid = await Bid.findOne({ playerId, isActive: true, isBidOn: true })
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
  getAdminQueueOverview,
  listMyQueueMemberships,
  isPromotedProxyBidder,
  resignActiveProxyToManual,
  afterBidPlaced,
  runProxyContinuation,
};
