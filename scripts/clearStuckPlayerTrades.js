/**
 * Clear active (pending/counter/admin_pending) trade requests for named players.
 *
 *   node scripts/clearStuckPlayerTrades.js --names "Rashid Khan,Chris Green" --dry-run
 *   node scripts/clearStuckPlayerTrades.js --names "Rashid Khan,Chris Green" --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Player = require('../models/Player');
const TradeRequest = require('../models/TradeRequest');
const User = require('../models/User');
const { clearActiveTradesForPlayers, ACTIVE_TRADE_STATUSES } = require('../utils/tradeApprovalShared');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const apply = args.includes('--apply');
const namesArg = args[args.indexOf('--names') + 1];

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGO_DB_NAME || undefined;
// Override: node scripts/clearStuckPlayerTrades.js --db cpl_22 --names "..." --apply
const dbArg = args[args.indexOf('--db') + 1];
const effectiveDb = dbArg || dbName;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findPlayersByNames(names) {
  const players = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const re = new RegExp(`^${escapeRegex(name)}$`, 'i');
    const matches = await Player.find({ name: re }).select('name type').lean();
    if (matches.length === 0) {
      const fuzzy = await Player.find({
        name: { $regex: escapeRegex(name), $options: 'i' },
      })
        .select('name type')
        .limit(5)
        .lean();
      if (fuzzy.length === 1) {
        players.push(fuzzy[0]);
      } else {
        console.warn(`No unique match for "${name}":`, fuzzy.map((p) => p.name));
      }
    } else if (matches.length === 1) {
      players.push(matches[0]);
    } else {
      console.warn(`Multiple matches for "${name}":`, matches.map((p) => `${p.name} (${p._id})`));
      players.push(matches[0]);
    }
  }
  return players;
}

async function run() {
  if (!namesArg) {
    console.error('Usage: --names "Player One,Player Two" (--dry-run | --apply)');
    process.exitCode = 1;
    return;
  }
  if (!apply && !dryRun) {
    console.error('Pass --dry-run or --apply');
    process.exitCode = 1;
    return;
  }

  const connectOpts = effectiveDb ? { dbName: effectiveDb } : {};
  await mongoose.connect(mongoUri, connectOpts);
  console.log(`Connected: ${mongoose.connection.name}${dryRun ? ' [DRY RUN]' : ''}`);

  const names = namesArg.split(',');
  const players = await findPlayersByNames(names);
  if (players.length === 0) {
    console.error('No players found for the given names.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const playerIds = players.map((p) => p._id);
  console.log('Players:', players.map((p) => `${p.name} (${p._id})`).join(', '));

  const activeTrades = await TradeRequest.find({
    status: { $in: ACTIVE_TRADE_STATUSES },
    $or: [
      { offeredPlayer: { $in: playerIds } },
      { requestedPlayer: { $in: playerIds } },
    ],
  })
    .populate('offeredPlayer', 'name')
    .populate('requestedPlayer', 'name')
    .populate('fromUser', 'teamName')
    .populate('toUser', 'teamName')
    .sort({ updatedAt: -1 });

  if (activeTrades.length === 0) {
    console.log('No active trade requests found for these players.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${activeTrades.length} active trade(s):`);
  for (const t of activeTrades) {
    console.log(
      `  - ${t._id} [${t.status}] ${t.fromUser?.teamName} → ${t.toUser?.teamName}: ` +
        `${t.offeredPlayer?.name} ↔ ${t.requestedPlayer?.name}`,
    );
  }

  if (dryRun) {
    console.log('Dry run only — no changes written.');
    await mongoose.disconnect();
    return;
  }

  const admin = await User.findOne({ isAdmin: true }).select('_id name').lean();
  const adminUserId = admin?._id || playerIds[0];
  const result = await clearActiveTradesForPlayers(adminUserId, playerIds);
  console.log(`Rejected ${result.cleared} active trade request(s). Teams can propose again.`);

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  try {
    await mongoose.disconnect();
  } catch (_) {}
});

