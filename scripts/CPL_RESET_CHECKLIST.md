# CPL Reset Checklist

This is the operational checklist for starting a new CPL season and for starting a fresh auction. It captures what to reset and what to keep.

## Before starting a new CPL season

### 1) Switch the database
- Change DB name to `cpl_19`.

### 2) Clear season data collections
Clear these collections completely:
- `fixtures`
- `pickrequests`
- `playerstats`
- `playofffixtures`
- `releaserequests`
- `schedules`
- `traderequests`

### 3) Reset player counters in `users` collection
For every player/user document, set:
- `fairnessPoint: 0`
- `points: 0`
- `matchesPlayed: 0`

db.users.updateMany(
  {},
  { $set: { fairnessPoint: 0, points: 0, matchesPlayed: 0 } }
)

## Before starting a fresh auction

### 1) Clear auction activity collections
Clear these collections completely:
- `bidhistories`
- `bidnotifications`
- `bids`
- `comments`
- `notifications`
- `postlikes`
- `useractivities`
- `fixtures`
- `pickrequests`
- `playerstats`
- `playofffixtures`
- `releaserequests`
- `schedules`
- `traderequests`

### 2) Reset player counters in `users` collection
For every player/user document, set:
- `fairnessPoint: 0`
- `points: 0`
- `matchesPlayed: 0`
- `allPlayersReleased: false`
- `isRetentionLocked: false`

### 3) Retained players handling
- Clear the `retainedplayers` collection.
- Then update `allPlayersReleased: false` and `isRetentionLocked: false` in the `users` collection (same as above).

## CPL report / history performance

### MongoDB indexes
After deploying, run **`POST /api/indexes/create-all`** (admin) so new compound indexes apply on each DB you use (including historical `cpl_*` DBs if you run the tool per database). Added indexes support CPL qualification overview and history point-table reads:
- **users:** `{ isActive: 1, isAdmin: 1, teamName: 1, points: -1 }`
- **fixtures:** `{ isActive: 1, winner: 1 }`

### Server-side cache (optional env)
- `CPL_REPORT_CACHE_TTL_SEC` — default `45` (in-memory snapshot shared by `/api/cpl-report/snapshot` and `/pdf`; cleared when points/fixtures emit `points_table_updated`).
- `CPL_HISTORY_CACHE_TTL_SEC` — default `120` (in-memory `/api/cpl-history/summary`; TTL-only; admin **clear all caches** also flushes it).

