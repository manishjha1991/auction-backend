#!/usr/bin/env node
/**
 * Find (and optionally delete) image files under cricket-player-portraits/ that are not
 * referenced by any Player.profilePicture in MongoDB — saves disk after renames/replacements.
 *
 * Env: MONGO_URI, optional MONGO_DB_NAME, PLAYER_PORTRAIT_DIR (default: cricket-player-portraits)
 *
 * Usage (from auction-backend/):
 *   node scripts/pruneOrphanPlayerPortraits.js # dry-run: list only
 *   node scripts/pruneOrphanPlayerPortraits.js --delete # remove orphan files
 */
require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const Player = require('../models/Player');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function normalizeDbPath(val) {
  if (!val || typeof val !== 'string') return null;
  const t = val.trim().replace(/^\/+/, '');
  if (!t || t.includes('..')) return null;
  if (t.toLowerCase().startsWith('http://') || t.toLowerCase().startsWith('https://')) {
    return null;
  }
  return t.split(path.sep).join('/');
}

async function collectReferencedPaths() {
  const refs = new Set();
  const cursor = Player.find({
    profilePicture: { $exists: true, $nin: [null, ''] },
  })
    .select('profilePicture')
    .lean()
    .cursor();

  for await (const doc of cursor) {
    const n = normalizeDbPath(doc.profilePicture);
    if (n) refs.add(n);
  }
  return refs;
}

async function listPortraitFiles(portraitDirAbs, relPrefix) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(portraitDirAbs, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('Portrait folder does not exist:', portraitDirAbs);
      process.exit(1);
    }
    throw e;
  }
  const prefix = relPrefix.split(path.sep).join('/');
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    files.push(`${prefix}/${ent.name}`);
  }
  return files;
}

async function main() {
  const doDelete = process.argv.includes('--delete');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGO_URI in .env');
    process.exit(1);
  }

  const relPrefix = String(process.env.PLAYER_PORTRAIT_DIR || 'cricket-player-portraits').replace(
    /^\/+|\/+$/g,
    ''
  );
  const portraitDirAbs = path.join(process.cwd(), relPrefix);

  await mongoose.connect(uri, process.env.MONGO_DB_NAME ? { dbName: process.env.MONGO_DB_NAME } : undefined);

  const referenced = await collectReferencedPaths();
  console.log(`Referenced portrait paths in DB: ${referenced.size}`);

  const onDisk = await listPortraitFiles(portraitDirAbs, relPrefix);
  console.log(`Image files on disk in ${relPrefix}/: ${onDisk.length}`);

  const orphans = onDisk.filter((rel) => !referenced.has(rel));

  if (orphans.length === 0) {
    console.log('No orphan files. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\nOrphan files (${orphans.length}) — not referenced by any player:`);
  for (const rel of orphans.sort()) {
    console.log(' ', rel);
  }

  if (!doDelete) {
    console.log('\nDry run only. Re-run with --delete to remove these files from disk.');
    await mongoose.disconnect();
    return;
  }

  let removed = 0;
  for (const rel of orphans) {
    const abs = path.join(process.cwd(), rel.split('/').join(path.sep));
    try {
      await fs.unlink(abs);
      removed++;
      console.log('Deleted:', rel);
    } catch (e) {
      console.warn('Could not delete', rel, e.message);
    }
  }
  console.log(`\nRemoved ${removed}/${orphans.length} file(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
