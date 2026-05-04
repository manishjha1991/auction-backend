#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Deletes PlayerStats rows that were saved as **playoff-only** (not World Cup) for
 * league games wrongly tagged as playoffs between **these three sides** (any pairing):
 *   · MSD Lions
 *   · ATL Punjab / ATL Punjab Kings (atl + punjab in matchName)
 *   · Sher Punjab / Sher-e / Shehre / similar (sher-style token + punjab)
 *
 * Matchups covered (matchName must satisfy the corresponding Mongo $and fragments):
 *   1. MSD Lions vs ATL Punjab (Kings)
 *   2. MSD Lions vs Sher Punjab
 *   3. ATL Punjab (Kings) vs Sher Punjab
 *
 * Linked data removed: same PlayerStats _ids → VenueMatchEntry.sourcePlayerStatsId;
 * Player embedded totals reversed; PlayerCareerSummary rebuilt for affected players.
 *
 * Only rows with playoff tagging are removed:
 *   metadata.isPlayoffScore === true OR root isPlayoffScore === true
 * Excludes World Cup rows: metadata.isWcScore === true is never deleted.
 *
 * When bulk OCR saved **without** `matchName`, use `--venue` to target rows
 * (default with `--venue`: only rows with **empty/missing** `matchName`, so real
 * playoff uploads with a title at the same ground are not deleted).
 *
 * For a **full wipe** of every stat + ledger line at specific grounds (e.g. one bad OCR
 * match per venue), use `--purge-venues` — removes **all** PlayerStats with that `venue`
 * (non–World Cup by default) and **all** VenueMatchEntry at those venues. Example:
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --purge-venues "West ovel" "Lahore Cricket Club"
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --purge-venues "West ovel" "Lahore Cricket Club" --apply
 *
 * Usage:
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js           # dry-run (matchName patterns only)
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --venue "West ovel"   # + venue (no matchName)
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --venue "West ovel" --venue-all-playoff  # all playoff@venue
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --apply   # perform writes
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --probe   # diagnostics
 *   node scripts/deleteMisTaggedPlayoffPlayerStats.js --purge-venues "West ovel" "Lahore Cricket Club" --purge-include-wc --apply
 *
 * DB: MONGO_URI required. Optional MONGO_DB_NAME.
 * Optional scope: --tournamentId <ObjectId> or TOURNAMENT_ID env.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Player = require('../models/Player');
const PlayerStats = require('../models/PlayerStats');
const VenueMatchEntry = require('../models/VenueMatchEntry');
const { upsertLiveCareerSummaryForPlayer } = require('../utils/playerCareerSummary');

const APPLY = process.argv.includes('--apply');
const PROBE = process.argv.includes('--probe');
const VENUE_ALL_PLAYOFF = process.argv.includes('--venue-all-playoff');
/** With `--purge-venues` only: also delete `metadata.isWcScore` rows at those grounds */
const PURGE_INCLUDE_WC = process.argv.includes('--purge-include-wc');
const DB_NAME = process.env.MONGO_DB_NAME || null;

/**
 * @param {string} flag e.g. '--venue'
 * @returns {string|null}
 */
function getCliValue(flag) {
  const withEq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq) {
    const v = withEq.slice(flag.length + 1).trim();
    try {
      return decodeURIComponent(v) || null;
    } catch {
      return v || null;
    }
  }
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) {
    const next = process.argv[idx + 1];
    if (next && !next.startsWith('-')) return next.trim() || null;
  }
  return null;
}

/**
 * @param {string} flag e.g. '--purge-venues'
 * @returns {string[]}
 */
function getCliMultiValue(flag) {
  /** @type {string[]} */
  const out = [];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) {
    eq
      .slice(flag.length + 1)
      .split(/[|,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => out.push(t));
  }
  const idx = process.argv.indexOf(flag);
  if (idx >= 0) {
    for (let i = idx + 1; i < process.argv.length; i += 1) {
      const a = process.argv[i];
      if (a.startsWith('-')) break;
      a.split(/[|,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((t) => out.push(t));
    }
  }
  return [...new Set(out)];
}

const PURGE_VENUE_LIST = getCliMultiValue('--purge-venues');
const VENUE_ARG_RAW = getCliValue('--venue');
const TOURNAMENT_ID_RAW = getCliValue('--tournamentId') || process.env.TOURNAMENT_ID || null;
const TOURNAMENT_ID =
  TOURNAMENT_ID_RAW && mongoose.Types.ObjectId.isValid(String(TOURNAMENT_ID_RAW))
    ? new mongoose.Types.ObjectId(String(TOURNAMENT_ID_RAW))
    : null;

function addTournamentScope(filter) {
  if (!TOURNAMENT_ID) return filter;
  return { $and: [{ tournamentId: TOURNAMENT_ID }, filter] };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Venue field: substring match, case-insensitive */
function venueMatchFilter(venueSubstring) {
  const t = String(venueSubstring || '').trim();
  if (!t) return null;
  return { venue: { $regex: new RegExp(escapeRegex(t), 'i') } };
}

const matchNameMissingFilter = {
  $or: [{ matchName: null }, { matchName: '' }, { matchName: { $exists: false } }],
};

/** Playoff-tagged, not WC */
const playoffNotWc = {
  $and: [
    {
      $or: [{ 'metadata.isPlayoffScore': true }, { isPlayoffScore: true }],
    },
    {
      $or: [{ 'metadata.isWcScore': { $ne: true } }, { 'metadata.isWcScore': { $exists: false } }],
    },
  ],
};

/** Sher / Sher-e / Shehre / “Sher a Punjab” style (must still include punjab) */
const SHERISH = /sher|shehre|shetre|sher\s*-\s*e|sher\s+e\s+|sher\s+a\s+/i;

/** Match labels as stored on PlayerStats.matchName (OCR bulk path) */

/** MSD Lions vs ATL Punjab (Kings) */
const fixtureMsdLionsVsAtlPunjab = {
  $and: [
    { matchName: { $regex: /msd/i } },
    { matchName: { $regex: /lions/i } },
    { matchName: { $regex: /atl/i } },
    { matchName: { $regex: /punjab/i } },
  ],
};

/** MSD Lions vs Sher Punjab */
const fixtureMsdLionsVsSherPunjab = {
  $and: [
    { matchName: { $regex: /msd/i } },
    { matchName: { $regex: /lions/i } },
    { matchName: { $regex: SHERISH } },
    { matchName: { $regex: /punjab/i } },
  ],
};

/** ATL Punjab (Kings) vs Sher Punjab — no MSD/Lions required */
const fixtureAtlPunjabVsSherPunjab = {
  $and: [
    { matchName: { $regex: /atl/i } },
    { matchName: { $regex: /punjab/i } },
    { matchName: { $regex: SHERISH } },
  ],
};

/** Team-vs-team patterns only (no playoff filter) — used for probing */
const fixtureFilterOnly = {
  $or: [
    fixtureMsdLionsVsAtlPunjab,
    fixtureMsdLionsVsSherPunjab,
    fixtureAtlPunjabVsSherPunjab,
  ],
};

/** matchName team patterns + playoff (probe / legacy) */
const fixturePlusPlayoffFilter = { $and: [playoffNotWc, fixtureFilterOnly] };

/**
 * Default: playoff + team tokens on matchName only.
 * With --venue: also matches playoff rows at that venue; default **missing matchName only**
 * unless --venue-all-playoff. Combined with matchName branch via $or.
 */
function buildTargetFilter(venueSubstring, venueAllPlayoff) {
  const venueF = venueMatchFilter(venueSubstring || '');
  if (!venueF) {
    return fixturePlusPlayoffFilter;
  }

  const venueBranch = venueAllPlayoff
    ? { $and: [playoffNotWc, venueF] }
    : { $and: [playoffNotWc, venueF, matchNameMissingFilter] };

  return {
    $or: [fixturePlusPlayoffFilter, venueBranch],
  };
}

/** Neither metadata nor root marks playoff */
const notPlayoffTagged = {
  $nor: [{ 'metadata.isPlayoffScore': true }, { isPlayoffScore: true }],
};

async function runProbe() {
  const playoffTotal = await PlayerStats.countDocuments(addTournamentScope(playoffNotWc));
  const playoffMissingName = await PlayerStats.countDocuments({
    $and: [addTournamentScope(playoffNotWc), matchNameMissingFilter],
  });

  const teamRowsTotal = await PlayerStats.countDocuments(addTournamentScope(fixtureFilterOnly));
  const teamAndPlayoff = await PlayerStats.countDocuments(addTournamentScope(fixturePlusPlayoffFilter));
  const teamLeagueOnly = await PlayerStats.countDocuments({
    $and: [addTournamentScope(fixtureFilterOnly), notPlayoffTagged],
  });

  const ledgerPlayoff = await VenueMatchEntry.countDocuments(
    TOURNAMENT_ID ? { isPlayoffScore: true, tournamentId: TOURNAMENT_ID } : { isPlayoffScore: true }
  );

  console.log('--- probe: counts ---');
  console.log(`PlayerStats playoff (non-WC), any matchName:     ${playoffTotal}`);
  console.log(`  … of those with NO/empty matchName:            ${playoffMissingName}`);
  console.log(`PlayerStats matching team-pair patterns:       ${teamRowsTotal}`);
  console.log(`  … also playoff-tagged (delete script target):  ${teamAndPlayoff}`);
  console.log(`  … same patterns but NOT playoff-tagged:        ${teamLeagueOnly}`);
  console.log(`VenueMatchEntry isPlayoffScore=true (any venue): ${ledgerPlayoff}`);
  console.log('');

  const venueBreakdown = await PlayerStats.aggregate([
    { $match: { $and: [addTournamentScope(playoffNotWc), matchNameMissingFilter] } },
    { $group: { _id: '$venue', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 20 },
  ]);
  if (venueBreakdown.length) {
    console.log('--- playoff + no matchName: rows per venue (top 20) ---');
    venueBreakdown.forEach((x) =>
      console.log(`  ${String(x.n).padStart(4)}  ${JSON.stringify(x._id)}`)
    );
    console.log('');
  }

  if (VENUE_ARG_RAW) {
    const venueF = venueMatchFilter(VENUE_ARG_RAW);
    const venuePreviewFilter = venueF
      ? VENUE_ALL_PLAYOFF
        ? { $and: [playoffNotWc, venueF] }
        : { $and: [playoffNotWc, venueF, matchNameMissingFilter] }
      : null;
    const venuePreview = venuePreviewFilter
      ? await PlayerStats.countDocuments(addTournamentScope(venuePreviewFilter))
      : 0;
    const fullPreview = venuePreviewFilter
      ? await PlayerStats.countDocuments(addTournamentScope(buildTargetFilter(VENUE_ARG_RAW, VENUE_ALL_PLAYOFF)))
      : 0;
    console.log(
      `--- with your CLI: --venue ${JSON.stringify(VENUE_ARG_RAW)}${VENUE_ALL_PLAYOFF ? ' --venue-all-playoff' : ' (missing matchName only)'} ---`
    );
    console.log(`  PlayerStats matching venue branch only:       ${venuePreview}`);
    console.log(`  PlayerStats matching full delete filter (\$OR): ${fullPreview}`);
    console.log('');
  }

  const samplePlayoff = await PlayerStats.find(addTournamentScope(playoffNotWc))
    .sort({ createdAt: -1 })
    .limit(15)
    .select('matchName metadata.isPlayoffScore isPlayoffScore venue createdAt')
    .lean();
  console.log('--- sample: recent playoff-tagged PlayerStats (non-WC) ---');
  samplePlayoff.forEach((r) =>
    console.log(
      `  ${String(r._id)} | meta=${r.metadata?.isPlayoffScore} root=${r.isPlayoffScore} | ${JSON.stringify(r.matchName)} | ${JSON.stringify(r.venue)}`
    )
  );
  console.log('');

  if (teamRowsTotal > 0) {
    const sampleTeam = await PlayerStats.find(addTournamentScope(fixtureFilterOnly))
      .sort({ createdAt: -1 })
      .limit(15)
      .select('matchName metadata.isPlayoffScore isPlayoffScore venue createdAt')
      .lean();
    console.log('--- sample: recent rows matching MSD/ATL/Sher team patterns ---');
    sampleTeam.forEach((r) =>
      console.log(
        `  ${String(r._id)} | meta=${r.metadata?.isPlayoffScore} root=${r.isPlayoffScore} | ${JSON.stringify(r.matchName)}`
      )
    );
  }
  console.log('');
}

function classifyMatchName(name) {
  const n = name || '';
  const msdLions = /msd/i.test(n) && /lions/i.test(n);
  const atlPunjab = /atl/i.test(n) && /punjab/i.test(n);
  const sherPunjab = SHERISH.test(n) && /punjab/i.test(n);
  /** @type {string[]} */
  const pairs = [];
  if (msdLions && atlPunjab) pairs.push('MSD↔ATL');
  if (msdLions && sherPunjab) pairs.push('MSD↔Sher');
  if (atlPunjab && sherPunjab) pairs.push('ATL↔Sher');
  return pairs;
}

async function applyPlayerStatDelta(playerId, delta) {
  const {
    runs = 0,
    balls = 0,
    runsGiven = 0,
    ballsBowled = 0,
    wickets = 0,
    mom = 0,
    matches = 0,
  } = delta;

  const inc = {};
  if (runs !== undefined && runs !== null && runs !== 0) inc.totalRuns = runs;
  if (balls !== undefined && balls !== null && balls !== 0) inc.totalBalls = balls;
  if (runsGiven !== undefined && runsGiven !== null && runs !== 0) inc.totalRunsGiven = runsGiven;
  if (ballsBowled !== undefined && ballsBowled !== null && balls !== 0) inc.totalBallsBowled = ballsBowled;
  if (wickets !== undefined && wickets !== null && wickets !== 0) inc.totalWickets = wickets;
  if (mom !== undefined && mom !== null && mom !== 0) inc.momCount = mom;
  if (matches !== undefined && matches !== null && matches !== 0) inc.matchesPlayed = matches;

  if (!Object.keys(inc).length) {
    console.log('  (no numeric delta for player)', String(playerId));
    return;
  }

  const result = await Player.findByIdAndUpdate(playerId, { $inc: inc });
  if (!result) {
    console.error('  ⚠️ Player not found for delta:', String(playerId), inc);
    return;
  }
  console.log('  ✓ Player totals adjusted', String(playerId), inc);
}

function aggregateNegatives(rows) {
  /** @type {Map<string, { runs: number; balls: number; runsGiven: number; ballsBowled: number; wickets: number; mom: number; matches: number }>} */
  const byPlayer = new Map();

  for (const doc of rows) {
    const pid = String(doc.playerId);
    if (!byPlayer.has(pid)) {
      byPlayer.set(pid, {
        runs: 0,
        balls: 0,
        runsGiven: 0,
        ballsBowled: 0,
        wickets: 0,
        mom: 0,
        matches: 0,
      });
    }
    const a = byPlayer.get(pid);
    a.runs -= doc.battingStats?.runs || 0;
    a.balls -= doc.battingStats?.balls || 0;
    a.runsGiven -= doc.bowlingStats?.runsGiven || 0;
    a.ballsBowled -= doc.bowlingStats?.ballsBowled || 0;
    a.wickets -= doc.bowlingStats?.wickets || 0;
    a.mom -= doc.isMom ? 1 : 0;
    a.matches -= 1;
  }

  return byPlayer;
}

/** @param {string[]} venueSubstrings */
function venuesOrFilter(venueSubstrings) {
  const list = [...new Set(venueSubstrings.map((s) => String(s).trim()).filter(Boolean))];
  if (!list.length) return null;
  return {
    $or: list.map((v) => ({
      venue: { $regex: new RegExp(escapeRegex(v), 'i') },
    })),
  };
}

/**
 * Remove all PlayerStats + VenueMatchEntry at the given venue strings (substring, case-insensitive).
 * Reverses Player embedded totals; rebuilds PlayerCareerSummary.
 */
async function runPurgeVenues(venueSubstrings, apply) {
  const vf = venuesOrFilter(venueSubstrings);
  if (!vf) {
    console.log('No venues in --purge-venues (add quoted ground names after the flag).');
    return;
  }

  const wcClause = PURGE_INCLUDE_WC
    ? null
    : {
        $or: [{ 'metadata.isWcScore': { $ne: true } }, { 'metadata.isWcScore': { $exists: false } }],
      };
  const playerStatsFilterRaw = wcClause ? { $and: [vf, wcClause] } : vf;
  const playerStatsFilter = addTournamentScope(playerStatsFilterRaw);
  const venueLedgerFilter = TOURNAMENT_ID ? { $and: [{ tournamentId: TOURNAMENT_ID }, vf] } : vf;

  const ledgerN = await VenueMatchEntry.countDocuments(venueLedgerFilter);
  const statsN = await PlayerStats.countDocuments(playerStatsFilter);

  const ledgerByVenue = await VenueMatchEntry.aggregate([
    { $match: venueLedgerFilter },
    { $group: { _id: '$venue', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  console.log('=== PURGE-VENUES (all stats + ledger at these grounds) ===\n');
  console.log('Venues:', JSON.stringify(venueSubstrings));
  console.log(`VenueMatchEntry rows to remove: ${ledgerN}`);
  console.log(
    `PlayerStats rows to remove:       ${statsN}${PURGE_INCLUDE_WC ? '' : ' (excluding metadata.isWcScore — use --purge-include-wc to include)'}`
  );

  if (ledgerByVenue.length) {
    console.log('\nVenueMatchEntry rows by exact `venue` string in DB:');
    ledgerByVenue.forEach((x) => console.log(`  ${x.n}  ${JSON.stringify(x._id)}`));
  }

  const rows = await PlayerStats.find(playerStatsFilter).lean();
  const byVenueStat = new Map();
  for (const r of rows) {
    const k = r.venue != null && r.venue !== '' ? String(r.venue) : '(no venue)';
    byVenueStat.set(k, (byVenueStat.get(k) || 0) + 1);
  }
  if (byVenueStat.size) {
    console.log('\nPlayerStats rows by exact `venue` string:');
    [...byVenueStat.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([v, n]) => console.log(`  ${n}  ${JSON.stringify(v)}`));
  }

  const negByPlayer = aggregateNegatives(rows);

  const perVenueSamples = 8;
  const rowsByVenue = new Map();
  for (const r of rows) {
    const k = r.venue != null && r.venue !== '' ? String(r.venue) : '(no venue)';
    if (!rowsByVenue.has(k)) rowsByVenue.set(k, []);
    rowsByVenue.get(k).push(r);
  }
  console.log('\nSamples (up to ' + perVenueSamples + ' per venue — scroll was only showing one venue before):');
  for (const [venue, list] of [...rowsByVenue.entries()].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]))
  )) {
    console.log(`\n  --- ${JSON.stringify(venue)}: ${list.length} row(s) ---`);
    for (const r of list.slice(0, perVenueSamples)) {
      console.log(
        `  _id=${r._id} playerId=${r.playerId} playoff=${r.metadata?.isPlayoffScore} wc=${r.metadata?.isWcScore}`
      );
    }
    if (list.length > perVenueSamples) {
      console.log(`  … +${list.length - perVenueSamples} more at this venue`);
    }
  }

  if (!rows.length) {
    console.log('\n(No PlayerStats matched the filter.)\n');
  }

  console.log('\nPer-player reverse deltas (Player collection $inc):');
  for (const [pid, d] of negByPlayer) console.log(`  ${pid}:`, d);

  if (!apply) {
    console.log(
      '\nDRY RUN — no writes. Add `--apply` to execute purge, then restart the API.\n'
    );
    return;
  }

  console.log('\nApplying purge…');
  for (const [pid, d] of negByPlayer) {
    await applyPlayerStatDelta(pid, d);
  }
  const delS = await PlayerStats.deleteMany(playerStatsFilter);
  const delL = await VenueMatchEntry.deleteMany(venueLedgerFilter);
  console.log(`\nDeleted PlayerStats: ${delS.deletedCount}`);
  console.log(`Deleted VenueMatchEntry: ${delL.deletedCount}`);

  console.log('\nRebuilding PlayerCareerSummary for affected players…');
  for (const pid of negByPlayer.keys()) {
    await upsertLiveCareerSummaryForPlayer(pid);
    console.log('  ✓', pid);
  }
  console.log(
    '\n⚠️  Restart the API (or flush in-memory caches) so venue explorer / rankings see fresh data.\n'
  );
}

(async () => {
  const start = Date.now();
  console.log(
    `\n=== deleteMisTaggedPlayoffPlayerStats ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`
  );
  console.log(`DB: ${DB_NAME || '(from MONGO_URI/default)'}`);
  if (TOURNAMENT_ID) {
    console.log(`Tournament scope: ${String(TOURNAMENT_ID)}`);
  }

  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set in .env');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI, DB_NAME ? { dbName: DB_NAME } : undefined);
    console.log(
      `Connected: ${mongoose.connection.name} @ ${mongoose.connection.host}\n`
    );

    if (PURGE_VENUE_LIST.length) {
      console.log(`Mode: --purge-venues (${PURGE_VENUE_LIST.length} ground(s)) — removes **all** stats + ledger lines at those venues.\n`);
      await runPurgeVenues(PURGE_VENUE_LIST, APPLY);
      await mongoose.disconnect();
      console.log(`Done in ${((Date.now() - start) / 1000).toFixed(2)}s.`);
      return;
    }

    if (PROBE) {
      console.log('=== PROBE (read-only diagnostics) ===\n');
      await runProbe();
      await mongoose.disconnect();
      console.log('Probe done.');
      return;
    }

    const targetFilter = addTournamentScope(buildTargetFilter(VENUE_ARG_RAW, VENUE_ALL_PLAYOFF));
    if (VENUE_ARG_RAW) {
      console.log(
        `Filter: $OR [ matchName MSD/ATL/Sher + playoff  |  venue ~ ${JSON.stringify(VENUE_ARG_RAW)} + playoff${
          VENUE_ALL_PLAYOFF ? '' : ' + empty/missing matchName'
        } ]\n`
      );
    } else {
      console.log(
        'Filter: playoff + matchName team-patterns only. If matchName was blank on upload, add e.g. --venue "West ovel".\n'
      );
    }

    const rows = await PlayerStats.find(targetFilter).lean();
    const ids = rows.map((r) => r._id);

    console.log(`Matched PlayerStats: ${rows.length}`);
    if (rows.length === 0) {
      console.log(`
Nothing to delete — no document matched the current filter.

If probe shows playoff rows with **no matchName** (like "West ovel" uploads), run:
  node scripts/deleteMisTaggedPlayoffPlayerStats.js --venue "West ovel"
  node scripts/deleteMisTaggedPlayoffPlayerStats.js --venue "West ovel" --apply

To wipe **everything** at West ovel + Lahore Cricket Club (both OCR matches / dossiers):
  node scripts/deleteMisTaggedPlayoffPlayerStats.js --purge-venues "West ovel" "Lahore Cricket Club"
  node scripts/deleteMisTaggedPlayoffPlayerStats.js --purge-venues "West ovel" "Lahore Cricket Club" --apply

Diagnose:
  node scripts/deleteMisTaggedPlayoffPlayerStats.js --probe
`);
      await mongoose.disconnect();
      return;
    }

    let nMsdAtl = 0;
    let nMsdSher = 0;
    let nAtlSher = 0;
    for (const r of rows) {
      for (const p of classifyMatchName(r.matchName)) {
        if (p === 'MSD↔ATL') nMsdAtl += 1;
        if (p === 'MSD↔Sher') nMsdSher += 1;
        if (p === 'ATL↔Sher') nAtlSher += 1;
      }
    }
    if (nMsdAtl + nMsdSher + nAtlSher > 0) {
      console.log(`  · MSD Lions ↔ ATL Punjab (Kings): ${nMsdAtl} row-hits`);
      console.log(`  · MSD Lions ↔ Sher Punjab: ${nMsdSher} row-hits`);
      console.log(`  · ATL Punjab ↔ Sher Punjab: ${nAtlSher} row-hits`);
      console.log('    (a row may count in more than one line if matchName is unusual)\n');
    } else {
      console.log(
        '  (No matchName-based team-pair tags on these rows — matched via --venue or empty title.)\n'
      );
    }

    for (const r of rows.slice(0, 25)) {
      console.log(
        `  - _id=${r._id} playerId=${r.playerId} matchName=${JSON.stringify(
          r.matchName || null
        )} playoffMeta=${r.metadata?.isPlayoffScore} playoffRoot=${r.isPlayoffScore} venue=${JSON.stringify(
          r.venue || null
        )}`
      );
    }
    if (rows.length > 25) {
      console.log(`  … ${rows.length - 25} more (not listed)\n`);
    } else {
      console.log('');
    }

    const negByPlayer = aggregateNegatives(rows);
    console.log('Per-player reverse deltas (sum of rows to remove):');
    for (const [pid, d] of negByPlayer) {
      console.log(`  ${pid}:`, d);
    }
    console.log('');

    const ledgerCount = await VenueMatchEntry.countDocuments(
      TOURNAMENT_ID
        ? { sourcePlayerStatsId: { $in: ids }, tournamentId: TOURNAMENT_ID }
        : { sourcePlayerStatsId: { $in: ids } }
    );
    console.log(`VenueMatchEntry rows linked by sourcePlayerStatsId: ${ledgerCount}\n`);

    if (!APPLY) {
      console.log('DRY RUN only — no writes. Re-run with `--apply` after you confirm the list.\n');
      await mongoose.disconnect();
      console.log(`Done in ${((Date.now() - start) / 1000).toFixed(2)}s.`);
      return;
    }

    for (const [pid, d] of negByPlayer) {
      await applyPlayerStatDelta(pid, d);
    }

    const delStats = await PlayerStats.deleteMany({ _id: { $in: ids } });
    console.log(`\nDeleted PlayerStats: ${delStats.deletedCount}`);

    const delLedger = await VenueMatchEntry.deleteMany(
      TOURNAMENT_ID
        ? { sourcePlayerStatsId: { $in: ids }, tournamentId: TOURNAMENT_ID }
        : { sourcePlayerStatsId: { $in: ids } }
    );
    console.log(`Deleted VenueMatchEntry: ${delLedger.deletedCount}`);

    console.log('\nRebuilding PlayerCareerSummary for affected players…');
    for (const pid of negByPlayer.keys()) {
      await upsertLiveCareerSummaryForPlayer(pid);
      console.log('  ✓ career summary', pid);
    }

    console.log(
      '\n⚠️  Restart the API (or flush in-memory caches) so stats-overview / venue analytics see fresh data.\n'
    );
    console.log(`Done in ${((Date.now() - start) / 1000).toFixed(2)}s.`);

    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ Script failed:', err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();
