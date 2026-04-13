const fs = require('fs').promises;
const path = require('path');

const DEFAULT_PORTRAIT_FOLDER = 'cricket-player-portraits';

/**
 * Delete a previously stored profile image on disk so replacements do not leak storage.
 * Allowed locations only (path must resolve under one of these project-relative roots):
 * - PLAYER_PORTRAIT_DIR or cricket-player-portraits/
 * - uploads/ (legacy multer disk storage)
 * Skips http(s) URLs, "..", and any path outside those folders.
 */
async function removeLocalProfilePictureIfSafe(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return;
  const trimmed = storedPath.trim();
  if (!trimmed || trimmed.includes('..')) return;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return;

  const cwd = process.cwd();
  const portraitRel = String(process.env.PLAYER_PORTRAIT_DIR || DEFAULT_PORTRAIT_FOLDER).replace(
    /^\/+|\/+$/g,
    ''
  );
  const absFile = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(cwd, trimmed.replace(/^\/+/, ''));

  const allowedRoots = [
    path.resolve(cwd, portraitRel),
    path.resolve(cwd, 'uploads'),
  ];

  const underAllowed = allowedRoots.some(
    (root) => absFile === root || absFile.startsWith(root + path.sep)
  );
  if (!underAllowed) return;

  try {
    await fs.unlink(absFile);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('Could not delete old profile picture:', e.message);
    }
  }
}

module.exports = { removeLocalProfilePictureIfSafe };
