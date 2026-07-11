# One-DB Cutover Runbook

This runbook is for moving from per-season databases (`cpl_*`) to one shared database with `tournamentId` scoping.

Use this in order. Do not skip dry-runs.

---

## 1) Preconditions (must be true)

- Code branch includes one-db scoping changes and is deployed to staging.
- Mongo backup/snapshot is available for all source DBs and target DB.
- `MONGO_URI` is set for target cluster.
- `MONGO_DB_NAME` points to the shared target DB (or DB is encoded in URI path).
- Tournament documents exist for all historical seasons you will import.
- You have a mapping from historical DB name -> `tournamentId`.

Suggested mapping format:

```json
{
  "cpl_15": "64f...a1",
  "cpl_16": "64f...a2",
  "cpl_17": "64f...a3"
}
```

---

## 2) Staging dry-run (no production traffic)

### 2.1 Deploy and health-check

- Start backend with staging env:
  - `MONGO_URI`
  - `MONGO_DB_NAME` (optional if URI includes DB)
- Verify:
  - `GET /api/test`
  - `GET /api/monitoring/*` endpoints (if enabled)

### 2.2 Indexes

- Ensure required indexes are created on target DB.
- Run your index creation endpoint/script once after deployment.
- Validate no unique conflicts for new compound indexes.

### 2.3 Data import rehearsal

For each legacy DB in scope:

1. Export collections.
2. Import into shared DB.
3. Stamp imported documents with mapped `tournamentId`.

Collections that must be scoped include at least:

- `fixtures`, `matchresults`, `playofffixtures`, `playerstats`
- `bids`, `bidhistories`, `bidplayerqueues`
- `pickrequests`, `releaserequests`, `traderequests`
- `userplayers`, `retainedplayers`, `schedules`

After each tournament import:

- Count validation (legacy count vs shared count filtered by `tournamentId`).
- Spot-check critical relations:
  - `UserPlayer` ↔ `Player`
  - `Bid`/`BidHistory` per player
  - playoff rows and match IDs

### 2.4 Sanity checks (staging only)

Run admin reset/sync flows in staging first, then run:

- `scripts/repairTournamentKnockout.js <tournamentId>`
- `scripts/recreateTournamentFixtures.js <tournamentId>`

Optional legacy fallback checks (if you still rely on old DBs):

- set `CPL_TEAM_CAREER_SOURCE=legacy-db` and verify output parity.

---

## 3) Functional regression (staging)

Run with **two tournaments in same DB**:

1. Enter fixture/match result for Tournament A.
   - Confirm Tournament B points/stats do not change.
2. Run auction/bid queue actions for Tournament B.
   - Confirm Tournament A queue/bids unaffected.
3. Same player appears in both seasons:
   - verify `UserPlayer` uniqueness still valid per tournament.
4. Playoff fixtures can reuse IDs (e.g. `WC1`, `F`) across tournaments.
5. `cplHistory`/`cplReport` endpoints:
   - validate response shape and season grouping.
6. Admin destructive flows (`retained/admin tools`) scoped by `tournamentId`.

If any cross-season bleed is detected, stop and fix before production.

---

## 4) Production cutover

### 4.1 Freeze window

- Announce read-only / low-traffic maintenance window.
- Pause cron jobs that mutate fixtures/stats/bids.

### 4.2 Backup

- Snapshot target DB.
- Snapshot all legacy `cpl_*` DBs (final pre-cutover backup).

### 4.3 Deploy backend

- Deploy branch with one-db changes.
- Set production env:
  - `MONGO_URI`
  - `MONGO_DB_NAME` (if needed)
  - optional source-mode flags only if legacy fallback is intended temporarily.

### 4.4 Migrate data

- Execute import + `tournamentId` stamping plan.
- Rebuild/verify indexes.
- Verify row counts per tournament.

### 4.5 Smoke tests (prod)

- `GET /api/test`
- One fixture/result write in a controlled tournament.
- One bid/queue action in another tournament.
- One report/history call.
- Confirm no errors in server logs.

If smoke is clean, re-enable cron/jobs.

---

## 5) Rollback plan

Trigger rollback if any of these happen:

- cross-tournament mutation leak
- critical endpoint failures on core flows
- index conflicts that block writes

Rollback steps:

1. Put app in maintenance mode.
2. Re-deploy previous stable backend build.
3. Restore DB snapshot to pre-cutover point.
4. Re-enable services.
5. Postmortem with failing queries/endpoints.

---

## 6) Post-cutover cleanup

- Remove legacy-db fallback env flags once confidence is high.
- Archive old migration scripts.
- Update docs to remove `cpl_*` operational guidance.
- Keep this runbook with final cutover notes and timestamps.
