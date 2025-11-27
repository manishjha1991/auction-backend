/**
 * Script: fixRetainedPlayers.js
 * ---------------------------------------------
 * This script synchronizes RetainedPlayer, UserPlayer, Player, and User collections
 * so that:
 *  - Every retained player has an active UserPlayer record mapped to the owner
 *  - Retained players have basePrice=17 Cr, isSold=true, isActive=true
 *  - Non-retained players are marked isSold=false, isActive=false
 *  - UserPlayer documents that aren't part of the retained list are removed
 *  - User purses are reset to 100 Cr minus 17 Cr per retained player
 *
 * The script first prints a dry-run summary and asks for confirmation
 * before making any modifications.
 *
 * Run with: NODE_ENV=production node scripts/fixRetainedPlayers.js
 */

/* eslint-disable no-console */
require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const RetainedPlayer = require('../models/RetainedPlayer');

const RETENTION_VALUE = 170000000; // 17 Cr
const BASE_PURSE = 1000000000; // 100 Cr

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askForConfirmation = (question) =>
  new Promise((resolve) => {
    rl.question(`${question} (yes/no): `, (answer) => {
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });

const HARD_CODED_URI =
  'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/?retryWrites=true&w=majority&appName=auction-app';

const connectDB = async () => {
  const uri = process.env.MONGO_URI || HARD_CODED_URI;

  await mongoose.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    dbName: 'cpl_17',
  });
  console.log('✅ Connected to MongoDB');
};

const disconnectDB = async () => {
  await mongoose.disconnect();
  rl.close();
  console.log('🔌 Disconnected from MongoDB');
};

const buildSummary = async () => {
  const retainedPlayers = await RetainedPlayer.find({ isActive: true }).lean();
  const retainedPlayerIds = retainedPlayers
    .map((rp) => rp.playerId)
    .filter(Boolean)
    .map((id) => id.toString());

  if (retainedPlayerIds.length === 0) {
    return {
      retainedPlayers,
      retainedPlayerIds,
      missingCombos: [],
      combosToDelete: 0,
      totalPlayers: await Player.countDocuments(),
      userRetentionCounts: new Map(),
    };
  }

  const existingUserPlayers = await UserPlayer.find(
    { playerId: { $in: retainedPlayerIds } },
    { playerId: 1, userId: 1 }
  ).lean();

  const comboSet = new Set(
    existingUserPlayers.map((up) => `${up.userId?.toString()}:${up.playerId?.toString()}`)
  );

  const missingCombos = retainedPlayers.filter((rp) => {
    if (!rp.userId || !rp.playerId) return false;
    return !comboSet.has(`${rp.userId.toString()}:${rp.playerId.toString()}`);
  });

  const combosToDelete = await UserPlayer.countDocuments({
    playerId: { $nin: retainedPlayerIds },
  });

  const userRetentionCounts = new Map();
  retainedPlayers.forEach((rp) => {
    if (!rp.userId) return;
    const key = rp.userId.toString();
    userRetentionCounts.set(key, (userRetentionCounts.get(key) || 0) + 1);
  });

  return {
    retainedPlayers,
    retainedPlayerIds,
    missingCombos,
    combosToDelete,
    totalPlayers: await Player.countDocuments(),
    userRetentionCounts,
  };
};

const applyFixes = async (summary) => {
  const {
    retainedPlayers,
    retainedPlayerIds,
    missingCombos,
    userRetentionCounts,
  } = summary;

  if (retainedPlayers.length === 0) {
    console.log('ℹ️ No active retained players found. Nothing to fix.');
    return;
  }

  // 1. Create missing UserPlayer combos
  if (missingCombos.length > 0) {
    const docsToInsert = missingCombos.map((rp) => ({
      userId: rp.userId,
      playerId: rp.playerId,
      bidValue: RETENTION_VALUE,
      isActive: true,
    }));
    await UserPlayer.insertMany(docsToInsert);
    console.log(`➕ Inserted ${docsToInsert.length} missing UserPlayer combinations`);
  }

  // 2. Ensure all retained combos are active with correct bid value
  await UserPlayer.updateMany(
    { playerId: { $in: retainedPlayerIds } },
    { $set: { isActive: true, bidValue: RETENTION_VALUE } }
  );
  console.log('🔄 Updated UserPlayer records for retained players');

  // 3. Remove UserPlayer combos not in retained list
  const deleteResult = await UserPlayer.deleteMany({
    playerId: { $nin: retainedPlayerIds },
  });
  console.log(`🗑️ Removed ${deleteResult.deletedCount} UserPlayer documents not in retained list`);

  // 4. Update player statuses
  await Player.updateMany(
    { _id: { $in: retainedPlayerIds } },
    {
      $set: {
        isSold: true,
        isActive: true,
        basePrice: RETENTION_VALUE,
      },
    }
  );
  console.log(`🏏 Marked ${retainedPlayerIds.length} retained players as sold/active with 17 Cr base price`);

  await Player.updateMany(
    { _id: { $nin: retainedPlayerIds } },
    {
      $set: {
        isSold: false,
        isActive: false,
      },
    }
  );
  console.log('🧹 Reset all non-retained players to unsold/inactive');

  // 5. Fix user purses
  const Decimal128 = mongoose.Types.Decimal128;
  const users = await User.find({}).select('_id purse isAdmin name teamName');
  let updatedUsers = 0;

  for (const user of users) {
    const retainedCount = userRetentionCounts.get(user._id.toString()) || 0;
    const targetPurse = BASE_PURSE - retainedCount * RETENTION_VALUE;
    const normalizedPurse = targetPurse < 0 ? 0 : targetPurse;
    const newPurseDecimal = Decimal128.fromString(normalizedPurse.toString());

    if (user.purse?.toString() !== newPurseDecimal.toString()) {
      user.purse = newPurseDecimal;
      await user.save();
      updatedUsers += 1;
    }
  }

  console.log(`💰 Updated purse for ${updatedUsers} users (Base: 100 Cr, -17 Cr per retained player)`);

  console.log('✅ Fix applied successfully!');
};

const main = async () => {
  try {
    await connectDB();
    console.log('🔎 Building dry-run summary...\n');

    const summary = await buildSummary();
    const {
      retainedPlayers,
      missingCombos,
      combosToDelete,
      totalPlayers,
      retainedPlayerIds,
    } = summary;

    console.log('📊 DRY RUN SUMMARY');
    console.log('-------------------');
    console.log(`Total retained players: ${retainedPlayers.length}`);
    console.log(`Missing UserPlayer combos: ${missingCombos.length}`);
    console.log(`UserPlayer combos to delete (non-retained): ${combosToDelete}`);
    console.log(`Players to mark sold/active: ${retainedPlayerIds.length}`);
    console.log(`Players to reset unsold/inactive: ${Math.max(totalPlayers - retainedPlayerIds.length, 0)}`);
    console.log('\nThis operation will also:');
    console.log('- Reset all non-retained players to unsold/inactive');
    console.log('- Ensure retained players have base price 17 Cr');
    console.log('- Reset all user purses to 100 Cr minus 17 Cr per retained player');

    const confirmed = await askForConfirmation('\nDo you want to apply these fixes?');

    if (!confirmed) {
      console.log('❌ Operation cancelled by user. No changes were made.');
      await disconnectDB();
      process.exit(0);
    }

    console.log('\n🚀 Applying fixes...');
    await applyFixes(summary);
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await disconnectDB();
    process.exit(0);
  }
};

main();


