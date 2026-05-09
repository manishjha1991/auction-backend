const mongoose = require("mongoose");
const User = require("../models/User");
const UserPlayer = require("../models/UserPlayer");
const BidPlayerQueue = require("../models/BidPlayerQueue");
const Player = require("../models/Player");

const BASELINE_PURSE = 1000000000; // 100 Cr

function toNumber(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  return Number(v?.toString?.() || 0);
}

async function reconcileUsersPurse({
  userIds = null,
  includeAdmins = false,
  dryRun = false,
  logIfChanged = true,
  logTag = "runtime",
} = {}) {
  const userFilter = {};
  if (!includeAdmins) userFilter.isAdmin = { $ne: true };
  if (Array.isArray(userIds) && userIds.length > 0) {
    userFilter._id = {
      $in: userIds.map((id) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id)),
    };
  }

  const users = await User.find(userFilter)
    .select("_id name teamName purse currentBids isAdmin")
    .lean();
  if (!users.length) {
    return { checked: 0, updated: 0, changes: [] };
  }

  const ids = users.map((u) => u._id);

  const purchases = await UserPlayer.find({
    userId: { $in: ids },
    isActive: true,
  })
    .select("userId bidValue")
    .lean();
  const purchaseByUser = new Map();
  for (const row of purchases) {
    const key = row.userId.toString();
    purchaseByUser.set(key, (purchaseByUser.get(key) || 0) + toNumber(row.bidValue));
  }

  const queueDocs = await BidPlayerQueue.find({
    "entries.userId": { $in: ids },
  })
    .select("playerId entries")
    .lean();
  const queuePlayerIds = [...new Set(queueDocs.map((d) => d.playerId).filter(Boolean))];
  const soldPlayers = await Player.find({ _id: { $in: queuePlayerIds }, isSold: true })
    .select("_id")
    .lean();
  const soldPlayerIdSet = new Set(soldPlayers.map((p) => p._id.toString()));
  const queueByUser = new Map();
  for (const doc of queueDocs) {
    if (soldPlayerIdSet.has(doc.playerId?.toString?.())) continue;
    for (const entry of doc.entries || []) {
      if (entry.status !== "queued" && entry.status !== "active_proxy") continue;
      const key = entry.userId.toString();
      queueByUser.set(key, (queueByUser.get(key) || 0) + toNumber(entry.lockedAmount));
    }
  }

  const changes = [];
  const ops = [];

  for (const user of users) {
    const uid = user._id.toString();
    const spentBought = purchaseByUser.get(uid) || 0;
    const currentBidLocks = (user.currentBids || []).reduce(
      (sum, bid) => sum + toNumber(bid.amount),
      0
    );
    const queuedLocked = queueByUser.get(uid) || 0;
    const expected = BASELINE_PURSE - spentBought - currentBidLocks - queuedLocked;
    const actual = toNumber(user.purse);
    if (actual !== expected) {
      changes.push({
        userId: uid,
        name: user.name || "",
        teamName: user.teamName || "",
        actual,
        expected,
        delta: actual - expected,
      });
      if (!dryRun) {
        ops.push({
          updateOne: {
            filter: { _id: user._id },
            update: {
              $set: { purse: mongoose.Types.Decimal128.fromString(String(expected)) },
            },
          },
        });
      }
    }
  }

  if (!dryRun && ops.length) {
    await User.bulkWrite(ops);
  }

  if (logIfChanged && !dryRun && changes.length > 0) {
    const preview = changes.slice(0, 10);
    console.warn(
      `[PURSE_RECONCILE][${logTag}] corrected ${changes.length} user purse(s).`,
      preview
    );
  }

  return {
    checked: users.length,
    updated: ops.length,
    changes,
  };
}

module.exports = {
  BASELINE_PURSE,
  reconcileUsersPurse,
};
