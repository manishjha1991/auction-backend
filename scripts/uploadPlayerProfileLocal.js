#!/usr/bin/env node
/**
 * Save one image under cricket-player-portraits/ and set Player.profilePicture to the relative path.
 *
 * Env: MONGO_URI, optional MONGO_DB_NAME, PLAYER_PORTRAIT_DIR
 *
 * Usage (from auction-backend/):
 *   node scripts/uploadPlayerProfileLocal.js <mongoObjectId> ./photo.jpg
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Player = require('../models/Player');
const { saveProfilePictureLocal } = require('../utils/saveProfilePictureLocal');
const { removeLocalProfilePictureIfSafe } = require('../utils/removeLocalProfilePictureIfSafe');
const { invalidateCache } = require('../utils/cache');

async function main() {
  const [, , playerId, filePath] = process.argv;
  if (!playerId || !filePath) {
    console.error('Usage: node scripts/uploadPlayerProfileLocal.js <playerMongoId> <imagePath>');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
  }
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGO_URI');
    process.exit(1);
  }
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB_NAME || 'cpl_20' });
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/jpeg';
  const previous = await Player.findById(playerId).select('profilePicture').lean();
  const { relativePath } = await saveProfilePictureLocal({
    buffer: buf,
    contentType: mime,
    playerId,
  });
  const updated = await Player.findByIdAndUpdate(
    playerId,
    { profilePicture: relativePath, updatedAt: new Date() },
    { new: true }
  ).lean();
  if (!updated) {
    console.error('Player not found:', playerId);
    process.exit(1);
  }
  if (previous?.profilePicture) {
    await removeLocalProfilePictureIfSafe(previous.profilePicture);
  }
  invalidateCache('players:data');
  invalidateCache('players:data:all');
  invalidateCache('user-purses');
  invalidateCache('user-details:');
  console.log('Updated', updated.name, '→', relativePath);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
