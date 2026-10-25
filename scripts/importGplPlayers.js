/**
 * Import GPL players from scripts/data/gpl-cricket-26.xlsx
 * (falls back to gpl-cricket-26.json if the xlsx is missing).
 *
 * Excel layout: type heading (Sapphire/Emerald/Gold/Silver), then
 * PLAYER NAME / ROLE / COUNTRY / BATTING STYLE / BOWLING STYLE / OVERALL.
 * Names may be numbered like "1. STEVE SMITH".
 *
 * Never creates a second document for the same player name.
 * New names insert. Existing names with changed fields ask y/N before update.
 *
 *   node scripts/importGplPlayers.js              # dry-run (no writes)
 *   node scripts/importGplPlayers.js --execute    # insert new; prompt on changes
 *   node scripts/importGplPlayers.js --execute --yes
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');

const Player = require('../models/Player');
const { invalidateCache } = require('../utils/cache');

const XLSX_PATH = path.join(__dirname, 'data', 'gpl-cricket-26.xlsx');
const JSON_PATH = path.join(__dirname, 'data', 'gpl-cricket-26.json');
const execute = process.argv.includes('--execute');
const autoYes = process.argv.includes('--yes');

const TYPES = ['Sapphire', 'Emerald', 'Gold', 'Silver'];
const ROLES = ['Batsman', 'Bowler', 'Allrounder', 'WicketKeeper'];
const BATTING_STYLES = ['LHB', 'RHB'];

const BASE_PRICE = {
  Sapphire: 20000000,
  Emerald: 15000000,
  Gold: 10000000,
  Silver: 1000000,
};

const ROLE_MAP = {
  batsman: 'Batsman',
  batsmen: 'Batsman',
  bowler: 'Bowler',
  bowlers: 'Bowler',
  wk: 'WicketKeeper',
  wicketkeeper: 'WicketKeeper',
  'wicket keeper': 'WicketKeeper',
  allrounder: 'Allrounder',
  allrounders: 'Allrounder',
  'all-rounder': 'Allrounder',
  'bat ar': 'Allrounder',
  'bowl ar': 'Allrounder',
  'batting-all-rounder': 'Allrounder',
  'bowling-all-rounder': 'Allrounder',
};

const COUNTRY_MAP = {
  australia: 'Australia',
  england: 'England',
  newzeland: 'New Zealand',
  'new zealand': 'New Zealand',
  pakistan: 'Pakistan',
  india: 'India',
  indja: 'India',
  zimbabwe: 'Zimbabwe',
  'west indies': 'West Indies',
  'south africa': 'South Africa',
  'sri lanka': 'Sri Lanka',
  bangladesh: 'Bangladesh',
  afghanistan: 'Afghanistan',
  ireland: 'Ireland',
};

const COMPARE_FIELDS = [
  'type',
  'role',
  'style',
  'bowlingStyle',
  'overallScore',
  'country',
  'basePrice',
];

const normalizeName = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

const titleName = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((part) => {
      if (part.length <= 2) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');

const mapType = (value) => {
  const raw = String(value || '').trim();
  const hit = TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
  return hit || raw;
};

const mapRole = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const mapped = ROLE_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  const hit = ROLES.find((r) => r.toLowerCase() === raw.toLowerCase());
  return hit || raw;
};

const mapCountry = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const mapped = COUNTRY_MAP[raw.toLowerCase()];
  if (mapped) return mapped;
  return titleName(raw);
};

const mapStyle = (value) => String(value || '').trim().toUpperCase();

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim().toLowerCase());
    });
  });

const connect = async () => {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is missing');
  const envDbName = (process.env.MONGO_DB_NAME || '').trim();
  await mongoose.connect(mongoUri, {
    ...(envDbName ? { dbName: envDbName } : {}),
    serverSelectionTimeoutMS: 15000,
  });
};

const stripPlayerNumber = (value) =>
  String(value || '')
    .trim()
    .replace(/^\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

const isTypeHeading = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  return TYPES.some((t) => t.toLowerCase() === raw);
};

const isColumnHeaderRow = (cells) => {
  const joined = cells.map((c) => String(c || '').trim().toLowerCase()).join(' ');
  return joined.includes('player name') && joined.includes('role');
};

const isSummaryRow = (cells) => {
  const first = String(cells[0] || '').trim().toLowerCase();
  const second = String(cells[1] || '').trim();
  if (first === 'total') return true;
  if (isTypeHeading(first) && /^\d+$/.test(second)) return true;
  return false;
};

const loadXlsxSheet = (filePath) => {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    defval: '',
    raw: true,
  });

  const players = [];
  let currentType = '';

  rows.forEach((rawRow) => {
    const cells = Array.isArray(rawRow) ? rawRow.slice(0, 6) : [];
    const first = String(cells[0] || '').trim();
    if (!first) return;
    if (isColumnHeaderRow(cells)) return;
    if (isSummaryRow(cells)) return;

    if (isTypeHeading(first) && !String(cells[1] || '').trim()) {
      currentType = mapType(first);
      return;
    }

    if (!currentType) return;

    players.push({
      name: stripPlayerNumber(first),
      type: currentType,
      role: cells[1],
      country: cells[2],
      battingStyle: cells[3],
      bowlingStyle: cells[4],
      overall: cells[5],
    });
  });

  return { filePath, players };
};

const loadJsonSheet = (filePath) => {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Sheet must be a JSON array');
  return { filePath, players: parsed };
};

const loadSheet = () => {
  if (fs.existsSync(XLSX_PATH)) return loadXlsxSheet(XLSX_PATH);
  if (fs.existsSync(JSON_PATH)) return loadJsonSheet(JSON_PATH);
  throw new Error(`Sheet not found. Expected ${XLSX_PATH} or ${JSON_PATH}`);
};

const validateRow = (row, index) => {
  const errors = [];
  const type = mapType(row.type);
  const role = mapRole(row.role);
  const style = mapStyle(row.battingStyle || row.style);
  const bowlingStyle = mapStyle(row.bowlingStyle);
  const country = mapCountry(row.country);
  const name = titleName(row.name);
  const overallScore = Number(row.overall ?? row.overallScore);
  const basePrice = BASE_PRICE[type];

  if (!name) errors.push('name missing');
  if (!TYPES.includes(type)) errors.push(`invalid type "${row.type}"`);
  if (!ROLES.includes(role)) errors.push(`invalid role "${row.role}"`);
  if (!BATTING_STYLES.includes(style)) errors.push(`invalid battingStyle "${row.battingStyle || row.style}"`);
  if (!bowlingStyle) errors.push('bowlingStyle missing');
  if (!country) errors.push('country missing');
  if (!Number.isFinite(overallScore)) errors.push('overall missing');
  if (!basePrice) errors.push('basePrice missing for type');

  return {
    index,
    errors,
    nameKey: normalizeName(name),
    payload: {
      name,
      type,
      role,
      style,
      bowlingStyle,
      country,
      overallScore,
      basePrice,
    },
  };
};

const diffFields = (existing, payload) => {
  const changes = [];
  for (const field of COMPARE_FIELDS) {
    const from = existing[field] ?? null;
    const to = payload[field] ?? null;
    if (String(from ?? '') !== String(to ?? '')) {
      changes.push({ field, from, to });
    }
  }
  return changes;
};

const formatChanges = (changes) =>
  changes.map((c) => `${c.field} ${c.from}→${c.to}`).join(', ');

const main = async () => {
  const { filePath, players: sheet } = loadSheet();
  const validated = sheet.map((row, index) => validateRow(row, index));

  const invalid = validated.filter((row) => row.errors.length > 0);
  const valid = validated.filter((row) => row.errors.length === 0);

  const seen = new Map();
  const sheetDupes = [];
  for (const row of valid) {
    if (seen.has(row.nameKey)) {
      sheetDupes.push(row);
    } else {
      seen.set(row.nameKey, row);
    }
  }
  const uniqueValid = valid.filter((row) => !sheetDupes.includes(row) && seen.get(row.nameKey) === row);

  const byType = {};
  for (const t of TYPES) byType[t] = 0;
  uniqueValid.forEach((row) => {
    byType[row.payload.type] += 1;
  });

  console.log(`Sheet: ${filePath}`);
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}${autoYes ? ' (--yes)' : ''}`);
  console.log(`Rows in sheet: ${sheet.length}`);
  console.log(`Valid unique: ${uniqueValid.length}`);
  console.log(`Invalid: ${invalid.length}`);
  console.log(`Duplicate names in sheet: ${sheetDupes.length}`);
  console.log('By type:', byType);
  console.log('');
  console.log('Required insert fields: playerID, name, type, role, basePrice, style, overallScore');
  console.log('Extra sheet fields saved: country, bowlingStyle');
  console.log('Defaults on insert: isSold=false, isActive=false, career stats=0, no photo');
  console.log('');

  if (invalid.length) {
    console.log('Invalid rows:');
    invalid.forEach((row) => {
      console.log(`  #${row.index + 1} ${sheet[row.index]?.name || '?'}: ${row.errors.join('; ')}`);
    });
    console.log('');
  }
  if (sheetDupes.length) {
    console.log('Sheet duplicates (skipped):');
    sheetDupes.forEach((row) => console.log(`  ${row.payload.name}`));
    console.log('');
  }

  await connect();
  console.log(`Database: ${mongoose.connection.name}`);

  const existingDocs = await Player.find({})
    .select('name type role style bowlingStyle country overallScore basePrice playerID')
    .lean();
  const byName = new Map();
  const multiMatches = new Set();
  existingDocs.forEach((doc) => {
    const key = normalizeName(doc.name);
    if (!key) return;
    if (byName.has(key)) multiMatches.add(key);
    else byName.set(key, doc);
  });

  const toInsert = [];
  const toAsk = [];
  const unchanged = [];
  const skippedMulti = [];

  for (const row of uniqueValid) {
    if (multiMatches.has(row.nameKey)) {
      skippedMulti.push(row);
      continue;
    }
    const existing = byName.get(row.nameKey);
    if (!existing) {
      toInsert.push(row);
      continue;
    }
    const changes = diffFields(existing, row.payload);
    if (changes.length === 0) unchanged.push(row);
    else toAsk.push({ row, existing, changes });
  }

  console.log('');
  console.log(`Would insert: ${toInsert.length}`);
  console.log(`Unchanged: ${unchanged.length}`);
  console.log(`Would ask to update: ${toAsk.length}`);
  console.log(`Skipped (multiple DB matches): ${skippedMulti.length}`);

  if (toInsert.length) {
    console.log('');
    console.log('Insert:');
    toInsert.forEach((row) => {
      console.log(
        `  + ${row.payload.name} | ${row.payload.type} | ${row.payload.role} | ${row.payload.country} | ${row.payload.style}/${row.payload.bowlingStyle} | ${row.payload.overallScore} | ₹${row.payload.basePrice}`
      );
    });
  }

  if (toAsk.length) {
    console.log('');
    console.log('Existing players with changes:');
    toAsk.forEach(({ row, changes }) => {
      console.log(`  ? ${row.payload.name}: ${formatChanges(changes)}`);
    });
  }

  if (skippedMulti.length) {
    console.log('');
    console.log('Ambiguous names (more than one DB document) — skipped:');
    skippedMulti.forEach((row) => console.log(`  ${row.payload.name}`));
  }

  if (!execute) {
    console.log('');
    console.log('Dry run only. Re-run with --execute to insert / ask updates.');
    await mongoose.disconnect();
    return;
  }

  let inserted = 0;
  for (const row of toInsert) {
    await Player.create({
      playerID: uuidv4(),
      ...row.payload,
      isSold: false,
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    inserted += 1;
    console.log(`Inserted ${row.payload.name}`);
  }

  let updated = 0;
  let declined = 0;
  for (const item of toAsk) {
    const { row, existing, changes } = item;
    const summary = formatChanges(changes);
    let approved = autoYes;
    if (!approved) {
      const answer = await ask(
        `Player "${row.payload.name}" already exists. ${summary}. Update this player? [y/N] `
      );
      approved = answer === 'y' || answer === 'yes';
    }
    if (!approved) {
      declined += 1;
      console.log(`Skipped update ${row.payload.name}`);
      continue;
    }
    await Player.updateOne(
      { _id: existing._id },
      {
        $set: {
          ...row.payload,
          updatedAt: new Date(),
        },
      }
    );
    updated += 1;
    console.log(`Updated ${row.payload.name}`);
  }

  try {
    invalidateCache('players:data');
  } catch (_) {}

  console.log('');
  console.log(`Done. inserted=${inserted} updated=${updated} declined=${declined} unchanged=${unchanged.length}`);
  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
