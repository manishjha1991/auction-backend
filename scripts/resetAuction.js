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

const collectionsToClear = [
  'bidhistories',
  'bidnotifications',
  'bids',
  'comments',
  'fixtures',
  'notifications',
  'pickrequests',
  'playerstats',
  'playofffixtures',
  'postlikes',
  'releaserequests',
  'retainedplayers',
  'schedules',
  'traderequests',
  'useractivities',
];

async function collectionExists(name) {
  const cursor = mongoose.connection.db.listCollections({ name });
  return await cursor.hasNext();
}

async function clearCollections() {
  for (const name of collectionsToClear) {
    const exists = await collectionExists(name);
    if (!exists) {
      console.log(`⚠️  Skipping missing collection: ${name}`);
      continue;
    }
    const result = await mongoose.connection.collection(name).deleteMany({});
    console.log(`🧹 Cleared ${name}: ${result.deletedCount} docs`);
  }
}

async function resetUsers() {
  const result = await mongoose.connection.collection('users').updateMany(
    {},
    {
      $set: {
        fairnessPoint: 0,
        points: 0,
        matchesPlayed: 0,
        allPlayersReleased: false,
        isRetentionLocked: false,
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

    await clearCollections();
    await resetUsers();

    console.log('🎯 Auction reset complete');
  } catch (error) {
    console.error('❌ Reset failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

run();
