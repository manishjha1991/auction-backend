const mongoose = require('mongoose');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');

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
      .select('_id name teamName purse')
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

    const currentPurseValue = toNumber(user.purse);
    const currentPurseCr = currentPurseValue / 10000000;
    const playersValueCr = totalPlayerValue / 10000000;
    const newPurseCr = 100 - playersValueCr;
    const differenceCr = newPurseCr - currentPurseCr;
    const newPurseValue = Math.max(newPurseCr, 0) * 10000000;

    updates.push({
      userId,
      teamName: user.teamName || user.name || 'Unknown',
      currentPurseCr,
      playersValueCr,
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

