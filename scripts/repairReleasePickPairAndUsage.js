/**
 * Fix an already-approved same-tier release + pick that double-counted tradesUsed.
 * Sets ReleaseRequest.pairedPickRequest and decrements User.tradesUsed by 1.
 *
 *   node scripts/repairReleasePickPairAndUsage.js --releaseId <mongoId> --pickId <mongoId> --dry-run
 *   node scripts/repairReleasePickPairAndUsage.js --releaseId ... --pickId ... --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const User = require('../models/User');
const Player = require('../models/Player');
const { pickIsAlreadyPairedToARelease } = require('../utils/releasePickPairing');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const apply = args.includes('--apply');
const rid = args[args.indexOf('--releaseId') + 1];
const pid = args[args.indexOf('--pickId') + 1];

const mongoUri =
  process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017';

async function run() {
  if (!rid || !pid) {
    console.error('Usage: --releaseId <id> --pickId <id> (--dry-run | --apply)');
    process.exitCode = 1;
    return;
  }
  if (!apply && !dryRun) {
    console.error('Pass --dry-run or --apply');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(mongoUri);
  const release = await ReleaseRequest.findById(rid);
  const pick = await PickRequest.findById(pid);
  if (!release || !pick) {
    console.error('Release or pick not found');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (String(release.user) !== String(pick.user)) {
    console.error('Release and pick must belong to the same user');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (release.status !== 'completed' || pick.status !== 'completed') {
    console.error('Both must be status completed');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (release.pairedPickRequest) {
    console.error('Release already has pairedPickRequest');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (await pickIsAlreadyPairedToARelease(pick._id)) {
    console.error('Pick is already linked from another release');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const [rp, pp] = await Promise.all([
    Player.findById(release.player).select('type name').lean(),
    Player.findById(pick.player).select('type name').lean(),
  ]);
  if (!rp || !pp || rp.type !== pp.type) {
    console.error('Released player and picked player must share the same tier', {
      releasePlayer: rp,
      pickPlayer: pp,
    });
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const userId = release.user;
  const u = await User.findById(userId).select('teamName tradesUsed').lean();

  console.log(
    JSON.stringify(
      {
        team: u?.teamName,
        tradesUsedBefore: u?.tradesUsed,
        releasePlayer: rp.name,
        pickPlayer: pp.name,
        tier: rp.type,
        dryRun,
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log('Dry run: no writes.');
    await mongoose.disconnect();
    return;
  }

  await ReleaseRequest.updateOne({ _id: release._id }, { $set: { pairedPickRequest: pick._id } });
  await User.collection.updateOne({ _id: userId }, [
    { $set: { tradesUsed: { $max: [{ $subtract: ['$tradesUsed', 1] }, 0] } } },
  ]);
  const after = await User.findById(userId).select('tradesUsed').lean();
  console.log('Updated pairedPickRequest; tradesUsed now:', after?.tradesUsed);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
