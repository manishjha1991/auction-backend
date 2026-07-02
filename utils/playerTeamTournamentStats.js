const mongoose = require('mongoose');
const Player = require('../models/Player');
const User = require('../models/User');
const PlayerStats = require('../models/PlayerStats');
const PlayerTeamTournamentStat = require('../models/PlayerTeamTournamentStat');

function normName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

function getCurrentTournamentKey() {
  return (
    process.env.CPL_TEAM_PLAYER_STATS_TOURNAMENT_KEY ||
    process.env.MONGO_DB_NAME ||
    mongoose.connection?.name ||
    'current'
  );
}

function getBackfillSourceDbs() {
  if (process.env.CPL_TEAM_PLAYER_STATS_DBS) {
    return process.env.CPL_TEAM_PLAYER_STATS_DBS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const from = parseInt(process.env.CPL_TEAM_PLAYER_STATS_FROM || '12', 10);
  const to = parseInt(process.env.CPL_TEAM_PLAYER_STATS_TO || '22', 10);
  const dbs = [];
  for (let i = from; i <= to; i += 1) dbs.push(`cpl_${i}`);
  return dbs;
}

function toObjectId(value) {
  if (!value) return null;
  const str = String(value);
  return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
}

function extractStatTotals(stat = {}) {
  return {
    runs: Number(stat?.battingStats?.runs) || 0,
    wickets: Number(stat?.bowlingStats?.wickets) || 0,
    mom: stat?.isMom ? 1 : 0,
    matches: 1,
  };
}

function parseMatchTeams(matchName = '') {
  const beforeVenue = String(matchName || '').split('@')[0].trim();
  if (!beforeVenue) return [];
  return beforeVenue
    .split(/\s+vs\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
}

function resolveHistoricalTeamForStat(stat, historicalUserById, historicalUsersByName) {
  const fallbackTeam = historicalUserById.get(String(stat.userId));
  const opponent = historicalUserById.get(String(stat.opponentUserId || ''));
  const matchTeams = parseMatchTeams(stat.matchName);

  if (matchTeams.length === 2 && opponent) {
    const opponentKeys = [opponent.teamName, opponent.abbreviation, opponent.name]
      .map(normName)
      .filter(Boolean);
    const actualTeamName = matchTeams.find((teamName) => !opponentKeys.includes(normName(teamName)));
    const inferred = historicalUsersByName.get(normName(actualTeamName));
    if (inferred) return inferred;
  }

  return fallbackTeam;
}

async function rebuildPlayerTeamTournamentStat({
  teamId,
  playerId,
  tournamentId = null,
  tournamentKey = getCurrentTournamentKey(),
}) {
  if (!teamId || !playerId || !tournamentKey) return null;

  const query = {
    userId: teamId,
    playerId,
  };

  if (tournamentId) {
    query.tournamentId = tournamentId;
  } else {
    query.$or = [{ tournamentId: null }, { tournamentId: { $exists: false } }];
  }

  const stats = await PlayerStats.find(query).select('battingStats bowlingStats isMom').lean();
  const totals = stats.reduce(
    (acc, stat) => {
      const row = extractStatTotals(stat);
      acc.totalRuns += row.runs;
      acc.totalWickets += row.wickets;
      acc.totalMom += row.mom;
      acc.matches += row.matches;
      return acc;
    },
    { totalRuns: 0, totalWickets: 0, totalMom: 0, matches: 0 }
  );

  if (totals.matches === 0) {
    await PlayerTeamTournamentStat.deleteOne({
      teamId,
      playerId,
      tournamentKey,
    });
    return null;
  }

  return PlayerTeamTournamentStat.findOneAndUpdate(
    { teamId, playerId, tournamentKey },
    {
      $set: {
        teamId,
        playerId,
        tournamentId: tournamentId || null,
        tournamentKey,
        totalRuns: totals.totalRuns,
        totalWickets: totals.totalWickets,
        totalMom: totals.totalMom,
        matches: totals.matches,
        sourceDatabase: mongoose.connection?.name || null,
      },
      $unset: { sourcePlayerStatsId: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function syncPlayerTeamTournamentStatFromPlayerStats(playerStatsDoc, options = {}) {
  if (!playerStatsDoc?.playerId || !playerStatsDoc?.userId) return null;
  return rebuildPlayerTeamTournamentStat({
    teamId: playerStatsDoc.userId,
    playerId: playerStatsDoc.playerId,
    tournamentId: playerStatsDoc.tournamentId || null,
    tournamentKey: options.tournamentKey || getCurrentTournamentKey(),
  });
}

async function loadCurrentLookupMaps() {
  const [players, users] = await Promise.all([
    Player.find({}).select('_id name').lean(),
    User.find({ isAdmin: { $ne: true } })
      .select('_id teamName abbreviation name')
      .lean(),
  ]);

  const playersByName = new Map();
  players.forEach((p) => {
    const key = normName(p.name);
    if (key && !playersByName.has(key)) playersByName.set(key, p);
  });

  const usersByTeam = new Map();
  users.forEach((u) => {
    [u.teamName, u.abbreviation, u.name].forEach((value) => {
      const key = normName(value);
      if (key && !usersByTeam.has(key)) usersByTeam.set(key, u);
    });
  });

  return { playersByName, usersByTeam };
}

async function buildHistoricalAggregatesForDb(dbName, lookupMaps) {
  const conn = mongoose.connection.useDb(dbName, { useCache: true });
  const db = conn.db;
  const [statsDocs, playerDocs, userDocs] = await Promise.all([
    db.collection('playerstats').find({ playerId: { $exists: true, $ne: null } }).toArray(),
    db.collection('players').find({}).project({ _id: 1, name: 1 }).toArray(),
    db.collection('users').find({}).project({ _id: 1, teamName: 1, abbreviation: 1, name: 1 }).toArray(),
  ]);

  const historicalPlayerById = new Map(playerDocs.map((p) => [String(p._id), p]));
  const historicalUserById = new Map(userDocs.map((u) => [String(u._id), u]));
  const historicalUsersByName = new Map();
  userDocs.forEach((u) => {
    [u.teamName, u.abbreviation, u.name].forEach((value) => {
      const key = normName(value);
      if (key && !historicalUsersByName.has(key)) historicalUsersByName.set(key, u);
    });
  });
  const aggregates = new Map();
  const skipped = {
    missingPlayer: 0,
    missingTeam: 0,
    unmatchedPlayer: 0,
    unmatchedTeam: 0,
  };

  statsDocs.forEach((stat) => {
    const historicalPlayer = historicalPlayerById.get(String(stat.playerId));
    if (!historicalPlayer?.name) {
      skipped.missingPlayer += 1;
      return;
    }
    const historicalTeam = resolveHistoricalTeamForStat(
      stat,
      historicalUserById,
      historicalUsersByName
    );
    if (!historicalTeam) {
      skipped.missingTeam += 1;
      return;
    }

    const targetPlayer = lookupMaps.playersByName.get(normName(historicalPlayer.name));
    if (!targetPlayer) {
      skipped.unmatchedPlayer += 1;
      return;
    }

    const targetTeam =
      lookupMaps.usersByTeam.get(normName(historicalTeam.teamName)) ||
      lookupMaps.usersByTeam.get(normName(historicalTeam.abbreviation)) ||
      lookupMaps.usersByTeam.get(normName(historicalTeam.name));

    if (!targetTeam) {
      skipped.unmatchedTeam += 1;
      return;
    }

    const key = `${targetTeam._id}:${targetPlayer._id}:${dbName}`;
    if (!aggregates.has(key)) {
      aggregates.set(key, {
        teamId: targetTeam._id,
        playerId: targetPlayer._id,
        tournamentId: toObjectId(stat.tournamentId),
        tournamentKey: dbName,
        sourceDatabase: dbName,
        totalRuns: 0,
        totalWickets: 0,
        totalMom: 0,
        matches: 0,
      });
    }

    const aggregate = aggregates.get(key);
    const row = extractStatTotals(stat);
    aggregate.totalRuns += row.runs;
    aggregate.totalWickets += row.wickets;
    aggregate.totalMom += row.mom;
    aggregate.matches += row.matches;
    if (!aggregate.tournamentId && stat.tournamentId) {
      aggregate.tournamentId = toObjectId(stat.tournamentId);
    }
  });

  return {
    dbName,
    statsRead: statsDocs.length,
    aggregates: [...aggregates.values()],
    skipped,
  };
}

async function backfillPlayerTeamTournamentStats(options = {}) {
  const sourceDbs = options.sourceDbs || getBackfillSourceDbs();
  const lookupMaps = await loadCurrentLookupMaps();
  const perDb = [];
  let upserts = 0;
  let deletedExisting = 0;

  if (options.reset !== false) {
    const deleteResult = await PlayerTeamTournamentStat.deleteMany({
      tournamentKey: { $in: sourceDbs },
    });
    deletedExisting = deleteResult.deletedCount || 0;
  }

  for (const dbName of sourceDbs) {
    const result = await buildHistoricalAggregatesForDb(dbName, lookupMaps);

    for (const aggregate of result.aggregates) {
      await PlayerTeamTournamentStat.findOneAndUpdate(
        {
          teamId: aggregate.teamId,
          playerId: aggregate.playerId,
          tournamentKey: aggregate.tournamentKey,
        },
        {
          $set: aggregate,
          $unset: { sourcePlayerStatsId: 1 },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      upserts += 1;
    }

    perDb.push({
      database: dbName,
      statsRead: result.statsRead,
      aggregateRows: result.aggregates.length,
      skipped: result.skipped,
    });
  }

  return {
    sourceDatabases: sourceDbs,
    deletedExisting,
    upserts,
    perDb,
  };
}

async function getPlayerTeamTournamentHistory(playerId) {
  if (!playerId) return [];

  return PlayerTeamTournamentStat.find({ playerId })
    .populate('teamId', 'teamName abbreviation teamImage themePrimary themeSecondary')
    .sort({ tournamentKey: 1, totalRuns: -1, totalWickets: -1 })
    .lean();
}

async function getGroupedPlayerTeamTournamentHistory(options = {}) {
  const playerId = options.playerId ? toObjectId(options.playerId) : null;
  const match = playerId ? { playerId } : {};

  const rows = await PlayerTeamTournamentStat.aggregate([
    { $match: match },
    {
      $lookup: {
        from: 'players',
        localField: 'playerId',
        foreignField: '_id',
        as: 'player',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'teamId',
        foreignField: '_id',
        as: 'team',
      },
    },
    { $unwind: { path: '$player', preserveNullAndEmptyArrays: true } },
    { $unwind: { path: '$team', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        teamName: {
          $ifNull: [
            '$team.abbreviation',
            { $ifNull: ['$team.teamName', 'Unknown Team'] },
          ],
        },
        teamFullName: { $ifNull: ['$team.teamName', '$team.abbreviation'] },
        playerName: { $ifNull: ['$player.name', 'Unknown Player'] },
      },
    },
    {
      $addFields: {
        teamKey: {
          $toLower: {
            $replaceAll: {
              input: '$teamName',
              find: ' ',
              replacement: '',
            },
          },
        },
      },
    },
    {
      $group: {
        _id: {
          playerId: '$playerId',
          teamKey: '$teamKey',
        },
        playerId: { $first: '$playerId' },
        playerName: { $first: '$playerName' },
        playerRole: { $first: '$player.role' },
        profilePicture: { $first: '$player.profilePicture' },
        teamName: { $first: '$teamName' },
        teamFullName: { $first: '$teamFullName' },
        teamImage: { $first: '$team.teamImage' },
        totalRuns: { $sum: '$totalRuns' },
        totalWickets: { $sum: '$totalWickets' },
        totalMom: { $sum: '$totalMom' },
        matches: { $sum: '$matches' },
        tournaments: {
          $push: {
            tournamentKey: '$tournamentKey',
            tournamentId: '$tournamentId',
            totalRuns: '$totalRuns',
            totalWickets: '$totalWickets',
            totalMom: '$totalMom',
            matches: '$matches',
          },
        },
      },
    },
    {
      $group: {
        _id: '$playerId',
        playerId: { $first: '$playerId' },
        playerName: { $first: '$playerName' },
        playerRole: { $first: '$playerRole' },
        profilePicture: { $first: '$profilePicture' },
        totalRuns: { $sum: '$totalRuns' },
        totalWickets: { $sum: '$totalWickets' },
        totalMom: { $sum: '$totalMom' },
        matches: { $sum: '$matches' },
        teams: {
          $push: {
            teamName: '$teamName',
            teamFullName: '$teamFullName',
            teamImage: '$teamImage',
            totalRuns: '$totalRuns',
            totalWickets: '$totalWickets',
            totalMom: '$totalMom',
            matches: '$matches',
            tournaments: '$tournaments',
          },
        },
      },
    },
    { $sort: { totalRuns: -1, totalWickets: -1, playerName: 1 } },
  ]);

  return rows.map((player) => ({
    ...player,
    teams: [...(player.teams || [])].sort((a, b) => {
      if ((b.totalRuns || 0) !== (a.totalRuns || 0)) return (b.totalRuns || 0) - (a.totalRuns || 0);
      if ((b.totalWickets || 0) !== (a.totalWickets || 0)) return (b.totalWickets || 0) - (a.totalWickets || 0);
      return String(a.teamName || '').localeCompare(String(b.teamName || ''));
    }).map((team) => ({
      ...team,
      tournaments: [...(team.tournaments || [])].sort((a, b) =>
        String(a.tournamentKey || '').localeCompare(String(b.tournamentKey || ''), undefined, {
          numeric: true,
        })
      ),
    })),
  }));
}

module.exports = {
  backfillPlayerTeamTournamentStats,
  getBackfillSourceDbs,
  getCurrentTournamentKey,
  getGroupedPlayerTeamTournamentHistory,
  getPlayerTeamTournamentHistory,
  rebuildPlayerTeamTournamentStat,
  syncPlayerTeamTournamentStatFromPlayerStats,
};
