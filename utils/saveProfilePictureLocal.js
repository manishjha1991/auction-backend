const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_FOLDER = 'cricket-player-portraits';

function extFromMime(mime) {
  const m = String(mime || 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  return 'jpg';
}

/**
 * Write portrait bytes next to wiki script output. Returns DB value: "cricket-player-portraits/file.jpg"
 * (served by express.static in server.js).
 */
async function saveProfilePictureLocal({ buffer, contentType, playerId }) {
  if (!buffer?.length) {
    throw new Error('Empty file');
  }
  const folder = process.env.PLAYER_PORTRAIT_DIR || DEFAULT_FOLDER;
  const relPrefix = String(folder).replace(/^\/+|\/+$/g, '');
  const dir = path.join(process.cwd(), relPrefix);
  await fs.mkdir(dir, { recursive: true });
  const ext = extFromMime(contentType);
  const safeId = String(playerId || 'p').replace(/[^a-fA-F0-9]/g, '').slice(-24) || 'p';
  const filename = `${safeId}-${uuidv4()}.${ext}`;
  const absPath = path.join(dir, filename);
  await fs.writeFile(absPath, buffer);
  const relativeForDb = `${relPrefix}/${filename}`;
  return { relativePath: relativeForDb, absPath };
}

module.exports = { saveProfilePictureLocal, extFromMime };
