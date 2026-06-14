const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');

/**
 * Map playerId → current owner teamName (active roster first, boughtPlayers fallback).
 */
async function buildCurrentOwnerTeamByPlayerId(playerIds = []) {
  const unique = [...new Set(playerIds.map(String).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const rosterRows = await UserPlayer.find({
    playerId: { $in: unique },
    isActive: true,
  })
    .populate('userId', 'teamName')
    .select('playerId userId')
    .lean();

  rosterRows.forEach((row) => {
    const team = String(row.userId?.teamName || '').trim();
    if (team) map.set(String(row.playerId), team);
  });

  const missing = unique.filter((id) => !map.has(id));
  if (missing.length) {
    const owners = await User.find({ boughtPlayers: { $in: missing } })
      .select('teamName boughtPlayers')
      .lean();
    owners.forEach((owner) => {
      const team = String(owner.teamName || '').trim();
      if (!team) return;
      (owner.boughtPlayers || []).forEach((pid) => {
        const key = String(pid);
        if (missing.includes(key) && !map.has(key)) map.set(key, team);
      });
    });
  }

  return map;
}

async function findCurrentOwnerUser(playerId) {
  if (!playerId) return null;
  const rosterRow = await UserPlayer.findOne({ playerId, isActive: true })
    .populate('userId', 'teamName abbreviation')
    .lean();
  if (rosterRow?.userId) return rosterRow.userId;
  return User.findOne({ boughtPlayers: playerId }).select('teamName abbreviation').lean();
}

function resolveTeamNameFromOwnerMap(ownerMap, playerId, fallback = 'Unknown Team') {
  const pid = String(playerId || '');
  if (ownerMap?.get?.(pid)) return ownerMap.get(pid);
  const trimmed = String(fallback || '').trim();
  return trimmed || 'Unknown Team';
}

module.exports = {
  buildCurrentOwnerTeamByPlayerId,
  findCurrentOwnerUser,
  resolveTeamNameFromOwnerMap,
};
