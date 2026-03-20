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

