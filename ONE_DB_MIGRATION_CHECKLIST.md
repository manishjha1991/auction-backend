# One-database migration checklist (CPL / auction-backend)

Use this when moving from **one MongoDB database per season** (`cpl_19`, `cpl_20`, …) to **a single database** with explicit **`tournamentId`** (and/or `seasonKey`) on season-scoped documents.

**Rule:** After migration, every read/write for league-specific data must be scoped. Regression-test with **two tournaments’ rows in the same DB**.

---

## Phase 0 — Decisions (fill in before coding)

- [ ] **Canonical season key:** `tournamentId` (ObjectId ref `Tournament`) vs numeric `seasonNumber` + separate doc — pick one primary filter for queries.
- [ ] **Head-to-head:** `TeamHeadToHead` is **all-time cumulative** vs **per tournament**. (Schema today is global per user-pair; per-season needs `tournamentId` in the unique index.)
- [ ] **Career stats:** `PlayerCareerSummary` / `User` career fields — single global document per player/team vs per-season subdocs (today `playerKey` is globally unique).
- [ ] **Default active tournament:** How admins/cron resolve “current” CPL when multiple `running` exist (env, `AppSettings`, or explicit param on every call).

---

## Phase 1 — Schema & indexes (audited)

Legend: **Scoped** = already has `tournamentId` in model. **Gap** = needs field + query/index updates. **Global** = intentionally shared across seasons.

| Model | Scoped? | Notes / unique-index risk |
|-------|---------|-----------------------------|
| `PlayerStats.js` | Yes | Has `tournamentId`; verify compound indexes for hot queries. |
| `VenueMatchEntry.js` | Yes | Has `tournamentId` + index. |
| `Tournament.js` | N/A | League container; fixtures embedded here — confirm no duplicate truth without scope elsewhere. |
| `Fixture.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. Route/query filters still pending. |
| `MatchResult.js` | **Updated (schema)** | Added `tournamentId`; replaced global unique assumption with migration-safe compound unique index `(tournamentId, matchNumber)`. |
| `PlayoffFixture.js` | **Updated (schema)** | Added `tournamentId`; added migration-safe unique index `(tournamentId, matchId)`. |
| `BidPlayerQueue.js` | **Updated (schema)** | Added `tournamentId`; replaced global `playerId` uniqueness with migration-safe unique `(tournamentId, playerId)`. |
| `UserPlayer.js` | **Updated (schema)** | Added `tournamentId`; partial unique now scoped per tournament for active rows. |
| `Bid.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `BidHistory.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `TradeRequest.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `ReleaseRequest.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `PickRequest.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `RetainedPlayer.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `TeamHeadToHead.js` | **Policy** | Unique on `(team1UserId, team2UserId)` only — global H2H; add `tournamentId` if H2H should reset per season. |
| `Schedule.js` | **Updated (schema)** | Added `tournamentId` + scoped indexes. |
| `User.js` | Global | `email` unique; career fields — do not wipe on new season. |
| `Player.js` | Global | `playerID` unique — correct for master player list. |
| `PlayerCareerSummary.js` | Global | `playerKey` unique — define how season totals roll into this in one DB. |
| `AppSettings.js` | Global | May hold “active tournament” pointer — review. |
| `Notification.js`, `Comment.js`, `PostLike.js`, etc. | Mixed | Audit if any are tournament-scoped. |

- [x] Add missing `tournamentId` (or agreed key) to the first critical set of **Gap** models (fixtures/matches/auction/requests/schedules).
- [x] Replace/adjust high-risk **unique** indexes in this batch (`MatchResult`, `BidPlayerQueue`, `UserPlayer`, `PlayoffFixture`) with migration-safe scoped uniques.
- [ ] Backfill script: set `tournamentId` on legacy rows (from source DB name → tournament mapping).

---

## Phase 2 — Application layer

- [~] **`server.js`:** Connection now uses `MONGO_DB_NAME`/URI path (no hardcoded season DB); broader runtime defaults audit still pending.
- [ ] **Middleware / context:** Resolve `tournamentId` once per request (param, header, JWT claim, or `AppSettings`) and pass into services.
- [ ] **Routes — season-scoped CRUD** (audit every `find` / `update` / `aggregate`):
  - [ ] `routes/tournaments.js`
  - [~] `routes/players.js` (bids/roster-trade/release endpoints and players-data cache+lookup now tournament-scoped; full route audit still pending)
  - [~] `routes/playerStats.js` (core stats paths already use tournamentId; destructive clear-cache path now scoped; full audit still pending for all helper queries)
  - [~] `routes/matchResults.js`, `routes/fixture.js`, `routes/livescores.js` (matchResults + fixture scoped; livescores is external feed/no season DB reads)
  - [~] `routes/bidRoutes.js`, `routes/bidQueueRoutes.js` (major sell/exit/dashboard/queue paths scoped; final hardening pass still recommended on very large bidRoutes file)
  - [~] `routes/trades.js`, `routes/releases.js`, `routes/picks.js`, `routes/retainedPlayers.js` (trades/releases/picks scoped; retainedPlayers high-risk release/cleanup flows now scoped, full route audit still pending)
  - [x] `routes/playoffFixtures.js`
  - [x] `routes/headToHead.js`
  - [x] `routes/schedules.js`
  - [~] `routes/adminTools.js`, `routes/adminRosterOps.js` (adminTools now scopes trade-activity/reconcile + release-pick-repair + purse/sync + `/auction/reset`; adminRosterOps roster trade/pick/release flows are scoped; remaining admin utilities still pending)
- [ ] **Multi-DB readers → single-DB filters:**
  - [~] `routes/cplHistory.js` (now supports single-DB tournament-based summary with legacy-db fallback via `source=legacy-db`)
  - [~] `routes/cplReport.js` + `utils/cplReportHelpers.js` (snapshot now supports single-DB completed tournaments with legacy-db fallback via `source=legacy-db`; deeper career/milestone historical utilities still need full conversion)
  - [~] `utils/teamCareerStats.js` (single-DB tournament aggregation added; legacy multi-DB retained behind `CPL_TEAM_CAREER_SOURCE=legacy-db`)
  - [~] `utils/runCareerHistorySeed.js`, `utils/migratePlayerTotalsFromHistoricalDbs.js` (single-DB tournament sources added; legacy multi-DB retained behind source env flags)
- [ ] **Caches:** `utils/cplReadCaches.js` — cache keys must include season/tournament scope.

---

## Phase 3 — Scripts & tooling

Update any `useDb(...)`, `MONGO_DB_NAME`, or hardcoded `cpl_*`:

- [~] `scripts/resetCplSeason.js`, `scripts/resetAuction.js` (tournament-scoped reset mode added via `--tournamentId` / `TOURNAMENT_ID`; `--all` keeps explicit global reset)
- [~] `scripts/repairTournamentKnockout.js`, `scripts/recreateTournamentFixtures.js` (already tournament-id driven; removed hardcoded `cpl_20` default DB assumption)
- [~] `scripts/migrateVenueToLedger.js`, `scripts/deleteMisTaggedPlayoffPlayerStats.js`, … (`deleteMisTagged...` now supports tournament scope + removed hardcoded DB default; `migrateVenueToLedger.js` not present in current repo)
- [~] `scripts/syncTeamCareerFromAllDbs.js` — now defaults to single-DB tournament aggregation with `CPL_TEAM_CAREER_SOURCE=legacy-db` fallback
- [~] Root utilities: `confirm-update-purse.js`, `sync-user-players-comprehensive.js`, `cleanup-fixtures.js`, etc. (added optional `--tournamentId`/`TOURNAMENT_ID` scoping in key scripts; removed hardcoded DB defaults in key + helper/test scripts)
- [x] `middleware/dbHealth.js`, `routes/connectionPool.js` (removed hardcoded sample DB names; now use env-driven reconnect options)

---

## Phase 4 — Data migration

- [ ] Export each `cpl_N` → import into shared DB with `tournamentId` / `seasonNumber` set.
- [ ] Resolve `_id` collisions (prefer keeping one cluster’s IDs; remap references if needed).
- [ ] Rebuild indexes; verify counts per tournament match legacy per-DB counts.
- [ ] Smoke: point tables, player stats totals, bid queues, rosters per season.

---

## Phase 5 — Regression tests (manual or automated)

Run with **two tournaments** in one database:

- [ ] Enter match result / stats → only active tournament’s table and stats move.
- [ ] Auction: queue + bids isolated per tournament (`BidPlayerQueue` uniqueness).
- [ ] Same player sold in season A and season B → `UserPlayer` partial unique still works.
- [ ] Playoff fixtures: two tournaments both use `WC1` … → no unique/collision errors.
- [ ] `MatchResult` / `matchNumber` uniqueness per tournament.
- [ ] CPL history / report endpoints: same JSON shape as before (season labels may use `seasonNumber` instead of `dbName`).
- [ ] Career aggregates: no double-count after merge.

---

## Quick reference — files that today assume multiple DBs

| Area | File(s) |
|------|---------|
| Server DB name | `server.js` (`dbName: 'cpl_20'`) |
| History API | `routes/cplHistory.js` |
| Reports | `routes/cplReport.js`, `utils/cplReportHelpers.js`, `utils/cplReportPdfFromSnapshot.js` |
| Team career | `utils/teamCareerStats.js`, `scripts/syncTeamCareerFromAllDbs.js` |
| Career seed/migrate | `utils/runCareerHistorySeed.js`, `utils/migratePlayerTotalsFromHistoricalDbs.js` |
| Caches | `utils/cplReadCaches.js` |

---

*Last audited against repo layout: models + grep for `tournamentId` / `useDb` / unique indexes.*
