const mongoose = require('mongoose');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const BidPlayerQueue = require('../models/BidPlayerQueue');

const BASELINE_PURSE = 1000000000; // 100 Cr
const CR_DIVISOR = 10000000;

const toNumber = (value) => {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  try {
    return Number(value);
  } catch {
    return 0;
  }
};

async function buildPurseUpdatePlan() {
  const [users, userPlayers] = await Promise.all([
    User.find({ isAdmin: { $ne: true } })
      .select('_id name teamName purse currentBids')
      .lean(),
    UserPlayer.find({ isActive: true })
      .select('userId bidValue')
      .lean(),
  ]);

  const userPlayerMap = new Map();
  userPlayers.forEach((up) => {
    if (!up.userId) return;
    const key = up.userId.toString();
    if (!userPlayerMap.has(key)) {
      userPlayerMap.set(key, []);
    }
    userPlayerMap.get(key).push(up);
  });

  const userIds = users.map((u) => u._id);
  const queueDocs = await BidPlayerQueue.find({
    'entries.userId': { $in: userIds },
  })
    .select('entries')
    .lean();

  const queueLocksByUser = new Map();
  for (const doc of queueDocs) {
    for (const entry of doc.entries || []) {
      if (entry.status !== 'queued' && entry.status !== 'active_proxy') continue;
      const key = entry.userId?.toString?.();
      if (!key) continue;
      const locked = Number(entry.lockedAmount) || 0;
      queueLocksByUser.set(key, (queueLocksByUser.get(key) || 0) + locked);
    }
  }

  const updates = [];
  let totalUsers = 0;
  let usersToUpdate = 0;

  users.forEach((user) => {
    const userId = user._id.toString();
    const associatedPlayers = userPlayerMap.get(userId) || [];
    const totalPlayerValue = associatedPlayers.reduce(
      (sum, up) => sum + (Number(up.bidValue) || 0),
      0
    );
    const currentBidLocks = (user.currentBids || []).reduce(
      (sum, bid) => sum + (Number(bid.amount) || 0),
      0
    );
    const queuedLocks = queueLocksByUser.get(userId) || 0;
    const totalCommitted = totalPlayerValue + currentBidLocks + queuedLocks;

    const currentPurseValue = toNumber(user.purse);
    const currentPurseCr = currentPurseValue / CR_DIVISOR;
    const playersValueCr = totalPlayerValue / CR_DIVISOR;
    const bidLocksCr = currentBidLocks / CR_DIVISOR;
    const queueLocksCr = queuedLocks / CR_DIVISOR;
    const newPurseValue = BASELINE_PURSE - totalCommitted;
    const newPurseCr = newPurseValue / CR_DIVISOR;
    const differenceCr = newPurseCr - currentPurseCr;

    updates.push({
      userId,
      teamName: user.teamName || user.name || 'Unknown',
      currentPurseCr,
      playersValueCr,
      bidLocksCr,
      queueLocksCr,
      newPurseCr,
      differenceCr,
      currentPurseValue,
      newPurseValue,
    });

    if (Math.abs(differenceCr) > 0.01) {
      usersToUpdate += 1;
    }
    totalUsers += 1;
  });

  return {
    summary: {
      totalUsers,
      usersToUpdate,
      usersUnchanged: totalUsers - usersToUpdate,
    },
    updates,
  };
}

async function executePursePlan(plan) {
  let updatedCount = 0;
  const failures = [];

  for (const op of plan.updates) {
    if (Math.abs(op.differenceCr) <= 0.01) continue;
    try {
      await User.findByIdAndUpdate(op.userId, {
        purse: mongoose.Types.Decimal128.fromString(op.newPurseValue.toString()),
      });
      updatedCount += 1;
    } catch (err) {
      failures.push({
        teamName: op.teamName,
        error: err.message,
      });
    }
  }

  return {
    summary: plan.summary,
    updatedCount,
    failures,
  };
}

async function runPurseAutoFix() {
  const plan = await buildPurseUpdatePlan();
  if (!plan.updates.some((op) => Math.abs(op.differenceCr) > 0.01)) {
    return {
      executed: false,
      summary: plan.summary,
      updatedCount: 0,
      failures: [],
    };
  }

  const result = await executePursePlan(plan);
  return {
    executed: true,
    summary: result.summary,
    updatedCount: result.updatedCount,
    failures: result.failures,
  };
}

module.exports = {
  buildPurseUpdatePlan,
  executePursePlan,
  runPurseAutoFix,
};

