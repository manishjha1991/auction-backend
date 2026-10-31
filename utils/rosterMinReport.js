const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const Bid = require('../models/Bid');
const PickRequest = require('../models/PickRequest');
const { getRosterCaps } = require('./rosterCaps');

const emptyTypeCounts = () => ({
  Sapphire: 0,
  Emerald: 0,
  Gold: 0,
  Silver: 0,
});

function bump(counts, type) {
  if (!counts[type]) counts[type] = 0;
  counts[type] += 1;
}

function isIndia(country) {
  return String(country || '').trim().toLowerCase() === 'india';
}

function shortfallLine(label, have, min) {
  const need = Math.max(0, min - have);
  return { label, have, min, need, ok: have >= min };
}

async function buildRosterMinReport() {
  const caps = await getRosterCaps();
  const users = await User.find({ isAdmin: { $ne: true } })
    .select('name teamName abbreviation isLocked isParticipating isTournamentReady')
    .sort({ teamName: 1, name: 1 })
    .lean();

  const userIds = users.map((u) => u._id);
  if (!userIds.length) {
    return { caps, shortCount: 0, okCount: 0, teams: [] };
  }

  const [ownedRows, bidRows, pickRows] = await Promise.all([
    UserPlayer.find({ userId: { $in: userIds }, isActive: true }).select('userId playerId').lean(),
    Bid.find({ bidder: { $in: userIds }, isActive: { $ne: false } }).select('bidder playerId').lean(),
    PickRequest.find({
      user: { $in: userIds },
      status: { $in: ['pending', 'admin_pending'] },
    })
      .select('user player')
      .lean(),
  ]);

  const playerIdSet = new Set();
  ownedRows.forEach((row) => row.playerId && playerIdSet.add(String(row.playerId)));
  bidRows.forEach((row) => row.playerId && playerIdSet.add(String(row.playerId)));
  pickRows.forEach((row) => row.player && playerIdSet.add(String(row.player)));

  const players = playerIdSet.size
    ? await Player.find({ _id: { $in: Array.from(playerIdSet) } })
        .select('type country isSold')
        .lean()
    : [];
  const playerById = new Map(players.map((p) => [String(p._id), p]));

  const ownedByUser = new Map();
  const liveByUser = new Map();
  const ensure = (map, id) => {
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  };
  ownedRows.forEach((row) => ensure(ownedByUser, row.userId).push(String(row.playerId)));
  bidRows.forEach((row) => ensure(liveByUser, row.bidder).push(String(row.playerId)));
  pickRows.forEach((row) => ensure(liveByUser, row.user).push(String(row.player)));

  const teams = users.map((user) => {
    const uid = String(user._id);
    const ownedIds = [...new Set(ownedByUser.get(uid) || [])];
    const liveIds = [...new Set(liveByUser.get(uid) || [])].filter((id) => !ownedIds.includes(id));

    const ownedCounts = emptyTypeCounts();
    const liveCounts = emptyTypeCounts();
    let ownedIndia = 0;
    let liveIndia = 0;

    ownedIds.forEach((id) => {
      const p = playerById.get(id);
      if (!p || p.isSold === false) return;
      bump(ownedCounts, p.type);
      if (isIndia(p.country)) ownedIndia += 1;
    });
    liveIds.forEach((id) => {
      const p = playerById.get(id);
      if (!p || p.isSold === true) return;
      bump(liveCounts, p.type);
      if (isIndia(p.country)) liveIndia += 1;
    });

    const total = {
      Sapphire: ownedCounts.Sapphire + liveCounts.Sapphire,
      Emerald: ownedCounts.Emerald + liveCounts.Emerald,
      Gold: ownedCounts.Gold + liveCounts.Gold,
      Silver: ownedCounts.Silver + liveCounts.Silver,
    };
    const seTotal = total.Sapphire + total.Emerald;

    const checks = [
      shortfallLine('Gold', total.Gold, caps.goldMin),
      shortfallLine('Silver', total.Silver, caps.silverMin),
      shortfallLine('Emerald', total.Emerald, caps.emeraldMin),
      shortfallLine('Sapphire', total.Sapphire, caps.sapphireMin),
      shortfallLine('Sapphire+Emerald', seTotal, caps.sapphireEmeraldMin),
    ];
    const missing = checks.filter((c) => !c.ok);

    return {
      userId: user._id,
      teamName: user.teamName || user.name,
      abbreviation: user.abbreviation || '',
      ownerName: user.name,
      isLocked: !!user.isLocked,
      owned: ownedCounts,
      live: liveCounts,
      total,
      india: { owned: ownedIndia, live: liveIndia, total: ownedIndia + liveIndia, max: caps.indiaMax },
      missing,
      missingLabels: missing.map((m) => `${m.label} ${m.have}/${m.min}`),
      ok: missing.length === 0,
    };
  });

  const shortTeams = teams.filter((t) => !t.ok);
  return {
    caps,
    shortCount: shortTeams.length,
    okCount: teams.length - shortTeams.length,
    teams,
  };
}

module.exports = { buildRosterMinReport };
