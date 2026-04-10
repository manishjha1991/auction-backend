/**
 * One-time / maintenance: set `releasedPlayerType` on completed ReleaseRequest docs
 * that predate the field, so same-tier unsold picks can pair correctly (routes/picks.js).
 *
 * Usage (from auction-backend):
 *   node scripts/backfillReleasedPlayerType.js           # apply updates
 *   node scripts/backfillReleasedPlayerType.js --dry-run # log only
 *   node scripts/backfillReleasedPlayerType.js --uri "mongodb://..." --db mydb
 */
require('dotenv').config();
const mongoose = require('mongoose');

const ReleaseRequest = require('../models/ReleaseRequest');
const Player = require('../models/Player');

const VALID_TYPES = ['Sapphire', 'Gold', 'Emerald', 'Silver'];
const TYPE_SET = new Set(VALID_TYPES);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbArgIndex = args.indexOf('--db');
const dbName = dbArgIndex >= 0 ? args[dbArgIndex + 1] : undefined;
const uriArgIndex = args.indexOf('--uri');
const mongoUri =
  (uriArgIndex >= 0 ? args[uriArgIndex + 1] : undefined) ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017';

async function run() {
  const options = dbName ? { dbName } : undefined;
  await mongoose.connect(mongoUri, options);
  console.log(`Connected: ${mongoose.connection.name}${dryRun ? ' [DRY RUN]' : ''}`);

  const cursor = ReleaseRequest.find({
    status: 'completed',
    $or: [
      { releasedPlayerType: { $exists: false } },
      { releasedPlayerType: null },
      { releasedPlayerType: '' },
      { releasedPlayerType: { $nin: VALID_TYPES } },
    ],
  }).cursor();

  let examined = 0;
  let updated = 0;
  let skippedNoPlayer = 0;
  let skippedBadType = 0;

  for await (const doc of cursor) {
    examined += 1;

    const player = await Player.findById(doc.player).select('type').lean();
    if (!player) {
      skippedNoPlayer += 1;
      console.warn(`No Player for release ${doc._id}, player ref ${doc.player}`);
      continue;
    }
    if (!TYPE_SET.has(player.type)) {
      skippedBadType += 1;
      console.warn(`Release ${doc._id}: player ${doc.player} has type "${player.type}" — skip`);
      continue;
    }

    if (dryRun) {
      updated += 1;
      console.log(`Would set ${doc._id} -> releasedPlayerType=${player.type}`);
      continue;
    }

    await ReleaseRequest.updateOne(
      { _id: doc._id },
      { $set: { releasedPlayerType: player.type } }
    );
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        examined,
        updatedOrWouldUpdate: updated,
        skippedNoPlayer,
        skippedBadType,
        dryRun,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  return mongoose.disconnect().catch(() => {});
});
