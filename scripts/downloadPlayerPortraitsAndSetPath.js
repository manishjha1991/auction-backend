#!/usr/bin/env node
/**
 * Cricket squad portraits (CPL-style roster = cricketers only):
 * 1) Connect to Mongo database cpl_20 (override with MONGO_DB_NAME).
 * 2) For each Player, fetch a portrait from English Wikipedia using cricket-focused search.
 * 3) Save files under ./cricket-player-portraits/<safe-name>.<ext> (folder configurable).
 * 4) Set Player.profilePicture to that relative path (e.g. cricket-player-portraits/Pat_Cummins.jpg).
 *    Serve files via express.static /cricket-player-portraits (see server.js).
 *
 * Usage (from auction-backend/):
 *   MONGO_URI="mongodb://..." node scripts/downloadPlayerPortraitsAndSetPath.js
 *   node scripts/downloadPlayerPortraitsAndSetPath.js --dry-run
 *   node scripts/downloadPlayerPortraitsAndSetPath.js --limit=20
 *   node scripts/downloadPlayerPortraitsAndSetPath.js --no-db-update   # only save files
 *
 * Env:
 *   MONGO_URI            required
 *   MONGO_DB_NAME        default cpl_20
 *   PLAYER_PORTRAIT_DIR  subfolder under cwd, default cricket-player-portraits
 *   PROFILE_PIC_DB_PREFIX stored in Mongo (path prefix), default cricket-player-portraits
 */
require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const Player = require('../models/Player');

const DB_NAME = process.env.MONGO_DB_NAME || 'cpl_20';
const DEFAULT_CRICKET_FOLDER = 'cricket-player-portraits';
const OUT_DIR = path.join(process.cwd(), process.env.PLAYER_PORTRAIT_DIR || DEFAULT_CRICKET_FOLDER);
const DB_PREFIX = (process.env.PROFILE_PIC_DB_PREFIX || DEFAULT_CRICKET_FOLDER).replace(/^\/+|\/+$/g, '');
const WIKI = 'https://en.wikipedia.org/w/api.php';
const UA =
  process.env.IMAGE_FETCH_USER_AGENT ||
  'CPLCricketPortraitScript/1.0 (cricket player images; https://meta.wikimedia.org/wiki/User-Agent_policy)';

/** Prefer Wikipedia hits that clearly relate to cricket (your DB is cricketers only). */
const CRICKET_HINT =
  /cricket|cricketer|batsman|batter|bowler|all-rounder|allrounder|wicket-keeper|wicketkeeper|ipl|cpl|bbl|psl|international\s+cricket/i;

function cricketHitScore(hit) {
  const blob = `${hit?.title || ''} ${hit?.snippet || ''}`;
  return CRICKET_HINT.test(blob) ? 1 : 0;
}
const MAX_BYTES = 6 * 1024 * 1024;

function parseArgs() {
  const o = { dryRun: false, limit: 0, noDbUpdate: false };
  for (const a of process.argv.slice(2)) {
    if (a === '--dry-run') o.dryRun = true;
    if (a === '--no-db-update') o.noDbUpdate = true;
    if (a.startsWith('--limit=')) o.limit = Math.max(0, parseInt(a.slice(8), 10) || 0);
  }
  return o;
}

function sanitizeBaseName(name) {
  return (
    String(name || 'player')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80) || 'player'
  );
}

function extFromCt(ct) {
  const c = String(ct || '').split(';')[0].trim().toLowerCase();
  if (c === 'image/png') return 'png';
  if (c === 'image/webp') return 'webp';
  if (c === 'image/gif') return 'gif';
  return 'jpg';
}

async function wikiGet(params) {
  const { data } = await axios.get(WIKI, {
    params: { ...params, format: 'json' },
    headers: { 'User-Agent': UA },
    timeout: 20000,
    validateStatus: (s) => s < 500,
  });
  return data;
}

async function fetchWikipediaThumbUrl(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return null;
  const queries = [
    `${name} cricketer`,
    `${name} international cricketer`,
    `${name} cricket`,
    `${name} IPL cricketer`,
    name,
  ];

  for (const srsearch of queries) {
    let searchData;
    try {
      searchData = await wikiGet({ action: 'query', list: 'search', srsearch, srlimit: 8 });
    } catch {
      continue;
    }
    const hits = [...(searchData?.query?.search || [])].sort(
      (a, b) => cricketHitScore(b) - cricketHitScore(a),
    );
    for (const hit of hits) {
      const title = hit?.title;
      if (!title) continue;
      let imgData;
      try {
        imgData = await wikiGet({ action: 'query', titles: title, prop: 'pageimages', pithumbsize: 400 });
      } catch {
        continue;
      }
      const pages = imgData?.query?.pages || {};
      for (const page of Object.values(pages)) {
        if (page?.thumbnail?.source) return page.thumbnail.source;
        if (page?.original?.source) return page.original.source;
      }
      await sleep(120);
    }
    await sleep(200);
  }
  return null;
}

async function downloadImage(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 25000,
    maxContentLength: MAX_BYTES,
    headers: { 'User-Agent': UA },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const buf = Buffer.from(res.data);
  if (buf.length > MAX_BYTES) throw new Error('too large');
  const ct = res.headers['content-type'] || 'image/jpeg';
  if (!/^image\//i.test(ct)) throw new Error(`not image: ${ct}`);
  return { buf, contentType: ct };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function uniqueFileBase(base, used) {
  let b = base;
  let n = 0;
  while (used.has(b)) {
    n += 1;
    b = `${base}_${n}`;
  }
  used.add(b);
  return b;
}

async function main() {
  const { dryRun, limit, noDbUpdate } = parseArgs();

  if (!process.env.MONGO_URI) {
    console.error('Set MONGO_URI in .env or environment.');
    process.exit(1);
  }

  if (!dryRun) {
    await fs.mkdir(OUT_DIR, { recursive: true });
  }
  console.log('Database:', DB_NAME, '(cricket roster → Wikipedia cricket-focused lookup)');
  console.log('Download folder:', OUT_DIR);
  console.log('profilePicture prefix in DB:', DB_PREFIX);

  await mongoose.connect(process.env.MONGO_URI, { dbName: DB_NAME });
  console.log('Connected. Collection: players');

  const usedNames = new Set();
  let done = 0;
  let ok = 0;
  let fail = 0;

  const cursor = Player.find({}).select('_id name profilePicture').sort({ name: 1 }).lean().cursor();

  for await (const p of cursor) {
    if (limit && done >= limit) break;
    done += 1;

    let imageUrl;
    try {
      imageUrl = await fetchWikipediaThumbUrl(p.name);
    } catch (e) {
      console.error('wiki search fail:', p.name, e.message);
      fail += 1;
      await sleep(250);
      continue;
    }

    if (!imageUrl) {
      console.warn('no image:', p.name);
      fail += 1;
      await sleep(150);
      continue;
    }

    const base = uniqueFileBase(sanitizeBaseName(p.name), usedNames);

    if (dryRun) {
      console.log('[dry-run]', p.name, '->', `${DB_PREFIX}/${base}.jpg`);
      ok += 1;
      await sleep(100);
      continue;
    }

    try {
      const { buf, contentType } = await downloadImage(imageUrl);
      const ext = extFromCt(contentType);
      const fileName = `${base}.${ext}`;
      const absFile = path.join(OUT_DIR, fileName);
      const dbValue = `${DB_PREFIX}/${fileName}`;

      await fs.writeFile(absFile, buf);
      console.log('saved', dbValue);

      if (!noDbUpdate) {
        await Player.updateOne({ _id: p._id }, { $set: { profilePicture: dbValue, updatedAt: new Date() } });
      }
      ok += 1;
    } catch (e) {
      console.error('download/write fail:', p.name, e.message);
      fail += 1;
    }

    await sleep(350);
  }

  await mongoose.disconnect();
  console.log(JSON.stringify({ playersProcessed: done, savedOrDryOk: ok, failed: fail, dryRun, noDbUpdate }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
