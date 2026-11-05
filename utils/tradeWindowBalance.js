const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const TradeRequest = require('../models/TradeRequest');

const TIERS = ['Sapphire', 'Gold', 'Emerald', 'Silver'];

function emptyTiers() {
  return { Sapphire: 0, Gold: 0, Emerald: 0, Silver: 0 };
}

function addTier(bag, type) {
  if (bag[type] != null) bag[type] += 1;
}

/** Same category only. 4 released and 4 picked = 4. 5 released and 4 picked = 5. Sapphire does not cover Emerald. */
function slotsForTiers(releases, picks) {
  let slots = 0;
  for (const tier of TIERS) {
    slots += Math.max(releases[tier] || 0, picks[tier] || 0);
  }
  return slots;
}

function goldSilverPrompts(releases, picks) {
  const prompts = [];
  for (const tier of ['Gold', 'Silver']) {
    const missing = (releases[tier] || 0) - (picks[tier] || 0);
    if (missing > 0) {
      prompts.push({
        type: tier,
        missing,
        message: `You need to pick ${missing} ${tier}. You released ${tier}, so pick the same category.`,
      });
    }
  }
  return prompts;
}

/** Squad is valid only as 2 Sapphire + 3 Emerald, or 1 Sapphire + 4 Emerald. */
function sapphireEmeraldPrompt(counts) {
  const sapphire = counts.Sapphire || 0;
  const emerald = counts.Emerald || 0;
  const ok = (sapphire === 2 && emerald === 3) || (sapphire === 1 && emerald === 4);
  if (ok) return null;
  return {
    type: 'SapphireEmerald',
    sapphire,
    emerald,
    message: `Sapphire and Emerald must be 2 Sapphire and 3 Emerald, or 1 Sapphire and 4 Emerald. You have ${sapphire} Sapphire and ${emerald} Emerald.`,
  };
}

async function moveTiersByUser(userIds) {
  const [releases, picks] = await Promise.all([
    ReleaseRequest.find({ status: 'completed', user: { $in: userIds } })
      .select('user releasedPlayerType player')
      .populate('player', 'type')
      .lean(),
    PickRequest.find({ status: 'completed', user: { $in: userIds } })
      .select('user player')
      .populate('player', 'type')
      .lean(),
  ]);

  const releaseMap = new Map();
  const pickMap = new Map();
  const ensure = (map, id) => {
    if (!map.has(id)) map.set(id, emptyTiers());
    return map.get(id);
  };

  for (const row of releases) {
    addTier(ensure(releaseMap, String(row.user)), row.releasedPlayerType || row.player?.type);
  }
  for (const row of picks) {
    addTier(ensure(pickMap, String(row.user)), row.player?.type);
  }
  return { releaseMap, pickMap };
}

async function swapCountsByUser() {
  const [fromRows, toRows] = await Promise.all([
    TradeRequest.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$fromUser', count: { $sum: 1 } } },
    ]),
    TradeRequest.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$toUser', count: { $sum: 1 } } },
    ]),
  ]);
  const map = new Map();
  for (const row of [...fromRows, ...toRows]) {
    const id = String(row._id);
    map.set(id, (map.get(id) || 0) + row.count);
  }
  return map;
}

async function rosterCounts(userId) {
  const rows = await UserPlayer.find({ userId, isActive: true }).populate('playerId', 'type').lean();
  const counts = emptyTiers();
  for (const row of rows) addTier(counts, row.playerId?.type);
  return counts;
}

async function promptsForUser(userId) {
  const { releaseMap, pickMap } = await moveTiersByUser([userId]);
  const releases = releaseMap.get(String(userId)) || emptyTiers();
  const picks = pickMap.get(String(userId)) || emptyTiers();
  const prompts = goldSilverPrompts(releases, picks);
  const roster = await rosterCounts(userId);
  const se = sapphireEmeraldPrompt(roster);
  if (se) prompts.push(se);
  return prompts;
}

/** Lock the trade total when the window closes: swaps plus the larger of releases or picks in each category. */
async function settleTradeWindowUsage() {
  const teams = await User.find({ isActive: true, isAdmin: false }).select('_id').lean();
  const ids = teams.map((team) => team._id);
  const [{ releaseMap, pickMap }, swaps] = await Promise.all([
    moveTiersByUser(ids),
    swapCountsByUser(),
  ]);

  const updates = [];
  for (const team of teams) {
    const id = String(team._id);
    const total =
      (swaps.get(id) || 0) +
      slotsForTiers(releaseMap.get(id) || emptyTiers(), pickMap.get(id) || emptyTiers());
    updates.push(User.updateOne({ _id: team._id }, { $set: { tradesUsed: total } }));
  }
  await Promise.all(updates);
  return updates.length;
}

module.exports = {
  TIERS,
  emptyTiers,
  slotsForTiers,
  moveTiersByUser,
  promptsForUser,
  settleTradeWindowUsage,
};
