/**
 * CLI to preview and repair ownership inconsistencies by reassigning players,
 * deducting the winning bid from the correct user, refunding all other bidders,
 * and syncing UserPlayer / Player / Bid collections.
 *
 * Usage: MONGODB_URI="mongodb://..." node scripts/fixAuctionState.js
 */

/* eslint-disable no-console */
const path = require('path');
const mongoose = require('mongoose');
const readline = require('readline');
const dotenv = require('dotenv');
const {
  previewAuctionFixes,
  executeAuctionFixes,
} = require('../utils/auctionFixHelpers');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const HARD_CODED_URI =
  'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/?retryWrites=true&w=majority&appName=auction-app';

const uri = process.env.MONGODB_URI || process.env.DB_URI || HARD_CODED_URI;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question) =>
  new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim().toLowerCase())));

function printIssues(preview) {
  const needingFix = preview.players.filter((player) => player.status === 'needs-fix');
  if (needingFix.length === 0) {
    console.log('✅ No ownership discrepancies detected.');
    return needingFix;
  }

  console.log('\nPlayers requiring attention:\n');
  needingFix.forEach((player, index) => {
    console.log(
      `${index + 1}. ${player.name} (${player.type}) | Current: ${
        player.currentOwner?.teamName || player.currentOwner?.name || 'Unknown'
      } ⇒ Correct: ${player.desiredOwner?.teamName || player.desiredOwner?.name || 'Unknown'} | Bid: ₹${
        player.desiredAmount
      }`,
    );
  });
  console.log('');
  return needingFix;

}

async function run() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, dbName: 'cpl_14' });
  console.log('Connected to Mongo');

  const preview = await previewAuctionFixes();
  console.log('Summary:', preview.summary);
  const needingFix = printIssues(preview);

  if (needingFix.length === 0) {
    rl.close();
    await mongoose.disconnect();
    process.exit(0);
  }

  const answer = await ask('Proceed with automatic fix for the players listed above? (y/N): ');
  if (answer !== 'y' && answer !== 'yes') {
    console.log('Aborting. No changes applied.');
    rl.close();
    await mongoose.disconnect();
    process.exit(0);
  }

  rl.close();
  console.log('\nRunning ownership fix...\n');
  const result = await executeAuctionFixes({
    playerIds: needingFix.map((p) => p.playerId),
  });

  result.details
    .filter((detail) => detail.status === 'fixed')
    .forEach((detail) => {
      console.log(
        `✔ ${detail.name} reassigned to ${detail.owner?.teamName || detail.owner?.name || 'Unknown'} for ₹${
          detail.amount
        }`,
      );
    });

  result.details
    .filter((detail) => detail.status === 'error')
    .forEach((detail) => {
      console.error(`✖ ${detail.name} failed: ${detail.message}`);
    });

  console.log('\nFinal Summary:', result.summary);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  rl.close();
  console.error('Fatal:', err);
  process.exit(1);
});

