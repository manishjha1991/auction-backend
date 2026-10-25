/**
 * Wipe the current-season player pool so teams can still log in with empty squads.
 *
 * Keeps: users (accounts), appsettings, venuematchentries, tournaments
 * Deletes: players + every roster / auction / fixture mapping that points at them
 *
 * Usage (from auction-backend):
 *   node scripts/fullPlayerPoolReset.js            # dry-run counts only
 *   node scripts/fullPlayerPoolReset.js --execute  # actually delete
 */
require('dotenv').config();
const mongoose = require('mongoose');

const WIPE_COLLECTIONS = [
  'players',
  'userplayers',
  'retainedplayers',
  'bids',
  'bidhistories',
  'bidnotifications',
  'bidplayerqueues',
  'comments',
  'notifications',
  'postlikes',
  'useractivities',
  'pickrequests',
  'releaserequests',
  'traderequests',
  'tradebundles',
  'tradeapprovalaudits',
  'playerstats',
  'playercareersummaries',
  'playerteamtournamentstats',
  'fixtures',
  'fixturesubmissions',
  'playofffixtures',
  'playoffsubmissions',
  'schedules',
  'matchresults',
  'teamheadtoheads',
];

const KEEP_COLLECTIONS = [
  'users',
  'appsettings',
  'venuematchentries',
  'tournaments',
];

const execute = process.argv.includes('--execute');

const connect = async () => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is missing');
  }
  const envDbName = (process.env.MONGO_DB_NAME || '').trim();
  await mongoose.connect(mongoUri, {
    ...(envDbName ? { dbName: envDbName } : {}),
    serverSelectionTimeoutMS: 15000,
  });
};

const listCollectionNames = async () => {
  const cols = await mongoose.connection.db.listCollections().toArray();
  return new Set(cols.map((c) => c.name));
};

const countIfExists = async (existing, name) => {
  if (!existing.has(name)) return { name, exists: false, count: 0 };
  const count = await mongoose.connection.collection(name).countDocuments();
  return { name, exists: true, count };
};

const resetUsers = async () => {
  // Keep login/team identity. Clear squad + season counters on every user.
  // Does not touch: name, email, password, teamName, teamImage, abbreviation,
  // group, timezone, streamLink, themes, isAdmin, isActive, isParticipating,
  // betWallet, careerMatchesPlayed, careerWins.
  return mongoose.connection.collection('users').updateMany(
    {},
    {
      $set: {
        boughtPlayers: [],
        captainPlayerId: null,
        currentBid: null,
        currentBids: [],
        purse: mongoose.Types.Decimal128.fromString('1000000000'),
        points: 0,
        matchesPlayed: 0,
        fairnessPoint: 0,
        tradesUsed: 0,
        allPlayersReleased: false,
        isRetentionLocked: false,
        isTournamentReady: false,
        isLocked: false,
      },
      $unset: { isSold: '' },
    }
  );
};

const resetAppSettings = async () => {
  return mongoose.connection.collection('appsettings').updateOne(
    {},
    {
      $set: {
        adminReleasedPlayers: false,
        adminReleasedPlayersAt: null,
        allPlayersReleased: false,
        enablePlayerRetention: true,
        releasedTeams: [],
        auctionStartAt: null,
        auctionAutoModeEnabled: false,
      },
    },
    { upsert: true }
  );
};

const main = async () => {
  await connect();
  const dbName = mongoose.connection.name;
  const existing = await listCollectionNames();

  console.log(`Database: ${dbName}`);
  console.log(`Mode: ${execute ? 'EXECUTE (deletes data)' : 'DRY RUN (no deletes)'}`);
  console.log('');

  const wipeCounts = [];
  for (const name of WIPE_COLLECTIONS) {
    wipeCounts.push(await countIfExists(existing, name));
  }

  const keepCounts = [];
  for (const name of KEEP_COLLECTIONS) {
    keepCounts.push(await countIfExists(existing, name));
  }

  const usersWithSquad = await mongoose.connection.collection('users').countDocuments({
    boughtPlayers: { $exists: true, $ne: [] },
  });
  const userPlayers = await countIfExists(existing, 'userplayers');
  const players = await countIfExists(existing, 'players');

  console.log('Will KEEP (accounts stay, login still works):');
  keepCounts.forEach((row) => {
    console.log(`  ${row.name}: ${row.exists ? row.count : 'missing'}`);
  });
  console.log('');
  console.log('Will WIPE:');
  wipeCounts.forEach((row) => {
    console.log(`  ${row.name}: ${row.exists ? row.count : 'missing'}`);
  });
  console.log('');
  console.log(`Users with boughtPlayers: ${usersWithSquad}`);
  console.log(`Players: ${players.count}`);
  console.log(`UserPlayer mappings: ${userPlayers.count}`);

  if (!execute) {
    console.log('');
    console.log('Dry run only. Re-run with --execute to apply.');
    await mongoose.disconnect();
    return;
  }

  console.log('');
  console.log('Wiping collections...');
  const deleted = [];
  for (const name of WIPE_COLLECTIONS) {
    if (!existing.has(name)) {
      deleted.push({ name, deletedCount: 0, skipped: true });
      continue;
    }
    const result = await mongoose.connection.collection(name).deleteMany({});
    deleted.push({ name, deletedCount: result.deletedCount || 0, skipped: false });
    console.log(`  cleared ${name}: ${result.deletedCount || 0}`);
  }

  const userResult = await resetUsers();
  console.log(`Reset users: matched ${userResult.matchedCount}, modified ${userResult.modifiedCount}`);

  const settingsResult = await resetAppSettings();
  console.log(`Reset appsettings: matched ${settingsResult.matchedCount}, modified ${settingsResult.modifiedCount}, upserted ${settingsResult.upsertedCount || 0}`);

  const leftoverPlayers = await mongoose.connection.collection('players').countDocuments();
  const leftoverMaps = existing.has('userplayers')
    ? await mongoose.connection.collection('userplayers').countDocuments()
    : 0;
  const leftoverRetained = existing.has('retainedplayers')
    ? await mongoose.connection.collection('retainedplayers').countDocuments()
    : 0;
  const leftoverSquads = await mongoose.connection.collection('users').countDocuments({
    boughtPlayers: { $exists: true, $ne: [] },
  });

  console.log('');
  console.log('Verify:');
  console.log(`  players left: ${leftoverPlayers}`);
  console.log(`  userplayers left: ${leftoverMaps}`);
  console.log(`  retainedplayers left: ${leftoverRetained}`);
  console.log(`  users still holding boughtPlayers: ${leftoverSquads}`);
  console.log(`  users left: ${await mongoose.connection.collection('users').countDocuments()}`);

  console.log('');
  console.log('Done. Teams can log in with empty squads. Add the new player set next.');
  console.log('Then clear backend cache / restart the server and hard-refresh the UI.');

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
