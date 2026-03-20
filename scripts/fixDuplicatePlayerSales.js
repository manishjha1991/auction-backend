/**
 * Script to find and fix duplicate player sales (same player sold twice to same team)
 * 
 * This script:
 * 1. Finds all UserPlayer entries where the same playerId + userId combination exists multiple times
 * 2. Identifies which entry should be kept (most recent, highest bid, or isActive: true)
 * 3. Removes duplicate entries
 * 4. Adjusts user purses if needed
 * 
 * Usage: MONGODB_URI="mongodb://..." node scripts/fixDuplicatePlayerSales.js
 */

/* eslint-disable no-console */
const path = require('path');
const mongoose = require('mongoose');
const readline = require('readline');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const HARD_CODED_URI =
  'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/?retryWrites=true&w=majority&appName=auction-app';

const uri = process.env.MONGODB_URI || process.env.DB_URI || HARD_CODED_URI;
const dbName = 'cpl_15';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) =>
  new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim().toLowerCase())));

async function findDuplicateSales() {
  const UserPlayer = mongoose.model('UserPlayer');
  const Player = mongoose.model('Player');
  const User = mongoose.model('User');

  console.log('🔍 Searching for duplicate player sales...\n');

  // Find all UserPlayer entries grouped by playerId + userId
  const duplicates = await UserPlayer.aggregate([
    {
      $match: {
        isActive: true, // Only check active entries
      },
    },
    {
      $group: {
        _id: {
          playerId: '$playerId',
          userId: '$userId',
        },
        entries: { $push: '$$ROOT' },
        count: { $sum: 1 },
      },
    },
    {
      $match: {
        count: { $gt: 1 }, // Only groups with more than 1 entry
      },
    },
  ]);

  if (duplicates.length === 0) {
    console.log('✅ No duplicate player sales found!');
    return [];
  }

  console.log(`⚠️  Found ${duplicates.length} duplicate player sales:\n`);

  const issues = [];

  for (const dup of duplicates) {
    const { playerId, userId } = dup._id;
    const entries = dup.entries;

    // Get player and user details
    const player = await Player.findById(playerId);
    const user = await User.findById(userId);

    if (!player || !user) {
      console.log(`⚠️  Skipping: Player or User not found (playerId: ${playerId}, userId: ${userId})`);
      continue;
    }

    // Sort entries to determine which one to keep
    // Priority: 1) isActive: true, 2) highest bidValue, 3) most recent createdAt
    entries.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      if (a.bidValue !== b.bidValue) return b.bidValue - a.bidValue; // Higher bid first
      return new Date(b.createdAt) - new Date(a.createdAt); // Most recent first
    });

    const keepEntry = entries[0];
    const removeEntries = entries.slice(1);

    // Calculate total bid value that was incorrectly deducted
    const totalBidDeduction = entries.reduce((sum, entry) => sum + entry.bidValue, 0);
    const correctBidDeduction = keepEntry.bidValue;
    const excessDeduction = totalBidDeduction - correctBidDeduction;

    issues.push({
      playerId,
      playerName: player.name,
      userId,
      userName: user.name || user.teamName,
      entries: entries.map((e) => ({
        _id: e._id,
        bidValue: e.bidValue,
        isActive: e.isActive,
        createdAt: e.createdAt,
      })),
      keepEntry: {
        _id: keepEntry._id,
        bidValue: keepEntry.bidValue,
        isActive: keepEntry.isActive,
        createdAt: keepEntry.createdAt,
      },
      removeEntries: removeEntries.map((e) => ({
        _id: e._id,
        bidValue: e.bidValue,
        createdAt: e.createdAt,
      })),
      excessDeduction,
    });

    console.log(
      `📋 ${player.name} → ${user.name || user.teamName}:`,
    );
    console.log(`   - Total entries: ${entries.length}`);
    console.log(`   - Keep: Entry ${keepEntry._id} (Bid: ₹${keepEntry.bidValue}, Created: ${new Date(keepEntry.createdAt).toLocaleString()})`);
    console.log(`   - Remove: ${removeEntries.length} duplicate(s)`);
    removeEntries.forEach((entry) => {
      console.log(`     • Entry ${entry._id} (Bid: ₹${entry.bidValue}, Created: ${new Date(entry.createdAt).toLocaleString()})`);
    });
    if (excessDeduction > 0) {
      console.log(`   - Excess purse deduction: ₹${excessDeduction} (will be refunded)`);
    }
    console.log('');
  }

  return issues;
}

async function fixDuplicateSales(issues, dryRun = true) {
  const UserPlayer = mongoose.model('UserPlayer');
  const User = mongoose.model('User');

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
    return { fixed: 0, refunded: 0, errors: [] };
  }

  console.log('🔧 Fixing duplicate sales...\n');

  let fixed = 0;
  let totalRefunded = 0;
  const errors = [];

  for (const issue of issues) {
    try {
      // Remove duplicate entries
      const removeIds = issue.removeEntries.map((e) => e._id);
      const deleteResult = await UserPlayer.deleteMany({
        _id: { $in: removeIds },
      });

      console.log(`✔ Removed ${deleteResult.deletedCount} duplicate entry/entries for ${issue.playerName} → ${issue.userName}`);

      // Refund excess purse deduction if needed
      if (issue.excessDeduction > 0) {
        const user = await User.findById(issue.userId);
        if (user) {
          const currentPurse = Number(user.purse) || 0;
          const newPurse = currentPurse + issue.excessDeduction;

          await User.updateOne(
            { _id: issue.userId },
            { $set: { purse: newPurse } },
          );

          console.log(`  💰 Refunded ₹${issue.excessDeduction} to ${issue.userName} (Purse: ₹${currentPurse} → ₹${newPurse})`);
          totalRefunded += issue.excessDeduction;
        }
      }

      fixed++;
    } catch (error) {
      const errorMsg = `Failed to fix ${issue.playerName} → ${issue.userName}: ${error.message}`;
      console.error(`✖ ${errorMsg}`);
      errors.push({ issue, error: errorMsg });
    }
  }

  return { fixed, refunded: totalRefunded, errors };
}

async function run() {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, dbName });
    console.log('✅ Connected to MongoDB\n');

    // Find duplicates
    const issues = await findDuplicateSales();

    if (issues.length === 0) {
      rl.close();
      await mongoose.disconnect();
      process.exit(0);
    }

    // Show summary
    const totalExcessDeduction = issues.reduce((sum, issue) => sum + issue.excessDeduction, 0);
    console.log('\n📊 Summary:');
    console.log(`   - Total duplicate sales: ${issues.length}`);
    console.log(`   - Total entries to remove: ${issues.reduce((sum, issue) => sum + issue.removeEntries.length, 0)}`);
    console.log(`   - Total excess deduction to refund: ₹${totalExcessDeduction}\n`);

    // Ask for confirmation
    const answer = await ask('Proceed with fixing these duplicates? (y/N): ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('❌ Aborting. No changes applied.');
      rl.close();
      await mongoose.disconnect();
      process.exit(0);
    }

    rl.close();

    // Fix duplicates
    const result = await fixDuplicateSales(issues, false);

    console.log('\n✅ Fix Complete!');
    console.log(`   - Fixed: ${result.fixed} duplicate sales`);
    console.log(`   - Total refunded: ₹${result.refunded}`);
    if (result.errors.length > 0) {
      console.log(`   - Errors: ${result.errors.length}`);
      result.errors.forEach((err) => console.log(`     • ${err.error}`));
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    rl.close();
    console.error('❌ Fatal error:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
}

// Load models
require('../models/UserPlayer');
require('../models/Player');
require('../models/User');

run();

