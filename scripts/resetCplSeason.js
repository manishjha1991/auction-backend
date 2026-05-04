require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const dbArgIndex = args.indexOf('--db');
const dbName = dbArgIndex >= 0 ? args[dbArgIndex + 1] : undefined;

const uriArgIndex = args.indexOf('--uri');
const mongoUri =
  (uriArgIndex >= 0 ? args[uriArgIndex + 1] : undefined) ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017';

const tournamentArgIndex = args.indexOf('--tournamentId');
const tournamentIdRaw =
  (tournamentArgIndex >= 0 ? args[tournamentArgIndex + 1] : undefined) ||
  process.env.TOURNAMENT_ID ||
  null;
const wipeAllArg = args.includes('--all');

const collectionsToClear = [
  'fixtures',
  'pickrequests',
  'playerstats',
  'playofffixtures',
  'releaserequests',
  'schedules',
  'traderequests',
];

const tournamentScopedCollections = new Set([
  'fixtures',
  'pickrequests',
  'playerstats',
  'playofffixtures',
  'releaserequests',
  'schedules',
  'traderequests',
]);

async function collectionExists(name) {
  const cursor = mongoose.connection.db.listCollections({ name });
  return await cursor.hasNext();
}

async function clearCollections() {
  const hasTournamentScope = Boolean(tournamentIdRaw) && !wipeAllArg;
  const tournamentId =
    hasTournamentScope && mongoose.Types.ObjectId.isValid(String(tournamentIdRaw))
      ? new mongoose.Types.ObjectId(String(tournamentIdRaw))
      : null;
  if (hasTournamentScope && !tournamentId) {
    throw new Error('Invalid tournamentId. Pass --tournamentId <ObjectId> or omit it.');
  }

  for (const name of collectionsToClear) {
    const exists = await collectionExists(name);
    if (!exists) {
      console.log(`⚠️  Skipping missing collection: ${name}`);
      continue;
    }
    if (hasTournamentScope && !tournamentScopedCollections.has(name)) {
      console.log(`⚠️  Skipping global collection in tournament mode: ${name}`);
      continue;
    }
    const filter =
      hasTournamentScope && tournamentScopedCollections.has(name)
        ? { tournamentId }
        : {};
    const result = await mongoose.connection.collection(name).deleteMany(filter);
    console.log(`🧹 Cleared ${name}: ${result.deletedCount} docs`);
  }
}

async function resetUsers() {
  const hasTournamentScope = Boolean(tournamentIdRaw) && !wipeAllArg;
  let userFilter = {};
  if (hasTournamentScope) {
    const tid = new mongoose.Types.ObjectId(String(tournamentIdRaw));
    const tournament = await mongoose.connection.db
      .collection('tournaments')
      .findOne({ _id: tid }, { projection: { subscribedTeams: 1 } });
    const userIds = (tournament?.subscribedTeams || [])
      .map((t) => t?.userId)
      .filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)))
      .map((id) => new mongoose.Types.ObjectId(String(id)));
    userFilter = userIds.length ? { _id: { $in: userIds } } : { _id: { $in: [] } };
  }

  const result = await mongoose.connection.collection('users').updateMany(
    userFilter,
    {
      $set: {
        fairnessPoint: 0,
        points: 0,
        matchesPlayed: 0,
      },
    }
  );
  console.log(
    `✅ Updated users: matched ${result.matchedCount}, modified ${result.modifiedCount}`
  );
}

async function run() {
  try {
    const options = dbName ? { dbName } : undefined;
    await mongoose.connect(mongoUri, options);
    console.log('✅ Connected to MongoDB');
    console.log(`🗄️  DB: ${mongoose.connection.name}`);
    if (wipeAllArg) {
      console.log('⚠️  Running in --all mode (global reset).');
    } else if (tournamentIdRaw) {
      console.log(`🎯 Tournament-scoped reset for tournamentId: ${tournamentIdRaw}`);
    } else {
      console.log('⚠️  No tournamentId provided; running global reset. Use --tournamentId to scope.');
    }

    await clearCollections();
    await resetUsers();

    console.log('🎯 CPL season reset complete');
  } catch (error) {
    console.error('❌ Reset failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
