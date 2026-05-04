/* eslint-disable no-console */
/**
 * Align the last 3 fixtures with current implementation:
 *   Semi 1 = 1st vs 4th, Semi 2 = 2nd vs 3rd (deduped point table, same sort as generate-knockout)
 *   Final = "Winner of Semi-Final 1" vs "Winner of Semi-Final 2"
 *   Knockout results on those 3 rows cleared; tournament champion cleared; status running if was completed.
 *
 * Usage:
 *   node scripts/repairTournamentKnockout.js <tournamentId>              # dry-run
 *   node scripts/repairTournamentKnockout.js <tournamentId> --apply     # write
 *   node scripts/repairTournamentKnockout.js --all                       # dry-run all tournaments that have KO
 *   node scripts/repairTournamentKnockout.js --all --apply              # fix all
 *
 * Options:
 *   --refresh-points   Recompute point table from all fixtures (matches generate-knockout) before reading top 4.
 *   --force            If fixtures ≥ RR+3 but knockout auto-detection fails, still replace the last 3 rows.
 *
 * If the tournament has only round-robin rows (count = n(n−1)/2) and every RR match has a winner, the script
 * appends the 3 knockout fixtures (same as “Initialize knockout” in the app).
 *
 * Requires .env: MONGO_URI. Optional MONGO_DB_NAME to target a specific DB.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Tournament = require('../models/Tournament');
const { updateTournamentPointTable } = require('../routes/tournaments');

const MONGO_DB_NAME = process.env.MONGO_DB_NAME || null;

const expectedRoundRobinFixtureCount = (tournament) => {
  const n = tournament?.subscribedTeams?.length || 0;
  return n >= 2 ? (n * (n - 1)) / 2 : 0;
};

const tournamentHasKnockoutStage = (tournament) => {
  const rr = expectedRoundRobinFixtureCount(tournament);
  const fx = tournament?.tournamentFixtures || [];
  if (rr > 0 && fx.length > rr) return true;
  return fx.some(
    (f) =>
      (f.team1 && (String(f.team1).includes('Winner of') || String(f.team1).includes('Top '))) ||
      (f.team2 && (String(f.team2).includes('Winner of') || String(f.team2).includes('Top ')))
  );
};

const sortPointTableLikeGenerateKnockout = (rows) =>
  [...rows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const nrrA = a.nrr || 0;
    const nrrB = b.nrr || 0;
    if (nrrB !== nrrA) return nrrB - nrrA;
    if (b.fairness !== a.fairness) return b.fairness - a.fairness;
    return 0;
  });

const dedupeByTeamName = (sortedRows) => {
  const seen = new Set();
  const out = [];
  for (const row of sortedRows) {
    const key = row.teamName ? String(row.teamName).trim() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
};

const emptyMom = () => ({ name: null, score: null, wickets: null });

const getUserIdFromTeamName = (tournament, teamName) => {
  const want = teamName ? String(teamName).trim() : '';
  const t = tournament.subscribedTeams.find((team) => String(team.teamName || '').trim() === want);
  return t?.userId || null;
};

function buildKnockoutTriplet(tournament, top4) {
  const top1UserId = getUserIdFromTeamName(tournament, top4[0].teamName);
  const top4UserId = getUserIdFromTeamName(tournament, top4[3].teamName);
  const top2UserId = getUserIdFromTeamName(tournament, top4[1].teamName);
  const top3UserId = getUserIdFromTeamName(tournament, top4[2].teamName);

  const base = { winner: null, margin: null, team1Score: null, team2Score: null, mom: emptyMom() };

  return [
    {
      ...base,
      team1: top4[0].teamName,
      team2: top4[3].teamName,
      team1UserId: top1UserId,
      team2UserId: top4UserId,
      team1Overs: null,
      team2Overs: null,
      team1Fairness: 0,
      team2Fairness: 0,
      createdAt: new Date(),
    },
    {
      ...base,
      team1: top4[1].teamName,
      team2: top4[2].teamName,
      team1UserId: top2UserId,
      team2UserId: top3UserId,
      team1Overs: null,
      team2Overs: null,
      team1Fairness: 0,
      team2Fairness: 0,
      createdAt: new Date(),
    },
    {
      ...base,
      team1: 'Winner of Semi-Final 1',
      team2: 'Winner of Semi-Final 2',
      team1UserId: null,
      team2UserId: null,
      team1Overs: null,
      team2Overs: null,
      team1Fairness: 0,
      team2Fairness: 0,
      createdAt: new Date(),
    },
  ];
}

function summarizeFixture(f, label) {
  if (!f) return `${label}: (missing)`;
  return `${label}: ${f.team1} vs ${f.team2}${f.winner ? ` → winner: ${f.winner}` : ''}`;
}

async function repairOne(tournamentId, { apply, refreshPoints, force }) {
  const log = console.log.bind(console);
  const err = console.error.bind(console);

  let tournament = await Tournament.findById(tournamentId);
  if (!tournament) {
    err(`Tournament not found: ${tournamentId}`);
    return { ok: false, reason: 'not_found' };
  }

  const subscribedCount = tournament.subscribedTeams?.length || 0;
  if (subscribedCount < 4) {
    err(`[${tournament.name}] Skip: need at least 4 subscribed teams (have ${subscribedCount}).`);
    return { ok: false, reason: 'not_enough_teams' };
  }

  if (refreshPoints) {
    log(`[${tournament.name}] Refreshing point table from fixtures…`);
    await updateTournamentPointTable(tournamentId);
    tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return { ok: false, reason: 'not_found_after_refresh' };
    }
  }

  const rrExpected = expectedRoundRobinFixtureCount(tournament);
  let fx = tournament.tournamentFixtures || [];
  const hasKo = tournamentHasKnockoutStage(tournament);

  if (rrExpected <= 0) {
    err(`[${tournament.name}] Skip: round-robin count is 0.`);
    return { ok: false, reason: 'no_rr' };
  }

  const pt = tournament.pointTable || [];
  if (pt.length === 0) {
    err(`[${tournament.name}] Skip: point table empty. Use --refresh-points or enter RR results first.`);
    return { ok: false, reason: 'empty_points' };
  }

  const sorted = sortPointTableLikeGenerateKnockout(pt);
  const uniqueByTeam = dedupeByTeamName(sorted);
  const top4 = uniqueByTeam.slice(0, 4);

  if (top4.length < 4) {
    err(`[${tournament.name}] Skip: need 4 distinct point-table teams after dedupe; found ${top4.length}.`);
    return { ok: false, reason: 'top4' };
  }

  const rrSlice = fx.slice(0, rrExpected);
  const allRrHaveWinner =
    rrSlice.length === rrExpected && rrSlice.every((f) => !!f.winner);

  // --- Append knockout (RR-only document, same as admin "Initialize knockout") ---
  if (!hasKo && fx.length === rrExpected) {
    if (!allRrHaveWinner) {
      const withWins = rrSlice.filter((f) => !!f.winner).length;
      err(
        `[${tournament.name}] Has ${fx.length} fixtures (= full round-robin) but no knockout rows yet. ` +
          `Need all ${rrExpected} round-robin matches to have a winner before appending knockouts (currently ${withWins} with winner).`
      );
      return { ok: false, reason: 'rr_incomplete' };
    }

    log(`\n── ${tournament.name} (${tournamentId}) — append 3 knockout fixtures ──`);
    log('Top 4 (seeds):');
    top4.forEach((r, i) => {
      log(`  ${i + 1}. ${r.teamName} — ${r.points} pts, NRR ${r.nrr ?? 0}`);
    });

    const triplet = buildKnockoutTriplet(tournament, top4);
    log('\nWill append (after existing RR):');
    log(summarizeFixture(triplet[0], 'new Semi 1'));
    log(summarizeFixture(triplet[1], 'new Semi 2'));
    log(summarizeFixture(triplet[2], 'new Final'));

    if (!apply) {
      log('(dry-run — no write)\n');
      return { ok: true, dryRun: true };
    }

    tournament.tournamentFixtures = [...fx, ...triplet];
    tournament.markModified('tournamentFixtures');

    if (tournament.winner?.teamName) {
      log('Clearing tournament champion.');
      tournament.winner = { teamName: null, teamImage: null, wonAt: null };
    }
    if (tournament.status === 'completed') {
      log('Setting status to running.');
      tournament.status = 'running';
    }

    await tournament.save();
    log('Saved (knockout appended).\n');
    return { ok: true, applied: true, appended: true };
  }

  // --- Replace last 3 (existing knockout) ---
  const canReplaceLast3 = fx.length >= rrExpected + 3 && (hasKo || force);
  if (!canReplaceLast3) {
    if (fx.length > rrExpected && fx.length < rrExpected + 3) {
      err(
        `[${tournament.name}] Skip: fixture count ${fx.length} is between RR (${rrExpected}) and RR+3 — data may be partial. Fix in DB or use a clean RR+KO set.`
      );
      return { ok: false, reason: 'partial_knockout' };
    }
    err(
      `[${tournament.name}] Skip: nothing to do (hasKo=${hasKo}, fixtures=${fx.length}, rrExpected=${rrExpected}). ` +
        `If you already have 3 knockout rows but detection failed, rerun with --force.`
    );
    return { ok: false, reason: 'no_knockout' };
  }

  if (force && !hasKo) {
    log(`⚠️  [${tournament.name}] --force: replacing last 3 fixtures even though knockout was not auto-detected.\n`);
  }

  log(`\n── ${tournament.name} (${tournamentId}) — replace last 3 fixtures ──`);
  log('Top 4 (seeds):');
  top4.forEach((r, i) => {
    log(`  ${i + 1}. ${r.teamName} — ${r.points} pts, NRR ${r.nrr ?? 0}`);
  });

  const n = fx.length;
  const iSemi1 = n - 3;
  const iSemi2 = n - 2;
  const iFinal = n - 1;

  log('\nCurrent last 3 (DB order):');
  log(summarizeFixture(fx[iSemi1], `[$${iSemi1}] Semi 1`));
  log(summarizeFixture(fx[iSemi2], `[$${iSemi2}] Semi 2`));
  log(summarizeFixture(fx[iFinal], `[$${iFinal}] Final`));

  const triplet = buildKnockoutTriplet(tournament, top4);

  log('\nAfter repair:');
  log(summarizeFixture(triplet[0], `[$${iSemi1}] Semi 1`));
  log(summarizeFixture(triplet[1], `[$${iSemi2}] Semi 2`));
  log(summarizeFixture(triplet[2], `[$${iFinal}] Final`));

  if (!apply) {
    log('(dry-run — no write)\n');
    return { ok: true, dryRun: true };
  }

  fx = [...fx];
  fx[iSemi1] = triplet[0];
  fx[iSemi2] = triplet[1];
  fx[iFinal] = triplet[2];
  tournament.tournamentFixtures = fx;
  tournament.markModified('tournamentFixtures');

  if (tournament.winner?.teamName) {
    log('Clearing tournament champion.');
    tournament.winner = { teamName: null, teamImage: null, wonAt: null };
  }
  if (tournament.status === 'completed') {
    log('Setting status to running.');
    tournament.status = 'running';
  }

  await tournament.save();
  log('Saved.\n');
  return { ok: true, applied: true };
}

(async () => {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const all = argv.includes('--all');
  const force = argv.includes('--force');
  const refreshPoints = argv.includes('--refresh-points');
  const idArg = argv.find((a) => !a.startsWith('--') && mongoose.isValidObjectId(a));

  if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI in environment (.env)');
    process.exit(1);
  }

  if (!all && !idArg) {
    console.error(
      'Usage:\n' +
        '  node scripts/repairTournamentKnockout.js <tournamentId> [--apply] [--refresh-points] [--force]\n' +
        '  node scripts/repairTournamentKnockout.js --all [--apply] [--refresh-points] [--force]'
    );
    process.exit(1);
  }

  if (all && idArg) {
    console.error('Use either --all or a tournament id, not both.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, MONGO_DB_NAME ? { dbName: MONGO_DB_NAME } : undefined);
  console.log(`Connected to MongoDB (database: ${mongoose.connection.name})\n`);

  if (all) {
    const tournaments = await Tournament.find({}).select('_id name tournamentFixtures subscribedTeams').lean();
    const eligible = [];
    for (const doc of tournaments) {
      if ((doc.subscribedTeams?.length || 0) < 4) continue;
      const rr = expectedRoundRobinFixtureCount(doc);
      if (rr <= 0) continue;
      const fx = doc.tournamentFixtures || [];
      const len = fx.length;
      const hasKo = tournamentHasKnockoutStage(doc);
      if (hasKo && len >= rr + 3) {
        eligible.push(doc._id.toString());
        continue;
      }
      if (!hasKo && len === rr) {
        const rrRows = fx.slice(0, rr);
        if (rrRows.length === rr && rrRows.every((f) => !!f.winner)) {
          eligible.push(doc._id.toString());
        }
      }
    }
    console.log(
      `${eligible.length} tournament(s) eligible (replace last 3 KO, or RR-complete with append).\n`
    );
    if (eligible.length === 0) {
      await mongoose.disconnect();
      process.exit(0);
    }
    let ok = 0;
    let fail = 0;
    for (const tid of eligible) {
      const r = await repairOne(tid, { apply, refreshPoints, force });
      if (r.ok) ok++;
      else fail++;
    }
    if (!apply) {
      console.log(`Dry-run done. ${ok} would repair, ${fail} skipped/errors. Add --apply to write.`);
    } else {
      console.log(`Done. ${ok} saved, ${fail} skipped/errors.`);
    }
    await mongoose.disconnect();
    process.exit(fail > 0 && ok === 0 ? 1 : 0);
  }

  const r = await repairOne(idArg, { apply, refreshPoints, force });
  await mongoose.disconnect();
  if (!apply && r.ok) {
    console.log('Dry-run only. Re-run with --apply to write changes.');
  }
  process.exit(r.ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
