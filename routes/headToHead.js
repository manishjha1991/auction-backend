/**
 * Head-to-head routes. Uses dedicated TeamHeadToHead collection.
 * Synced from Fixture, MatchResult, PlayoffFixture. Keeps updating when fixture/match/playoff is saved.
 */
const express = require('express');
const router = express.Router();
const Fixture = require('../models/Fixture');
const MatchResult = require('../models/MatchResult');
const PlayoffFixture = require('../models/PlayoffFixture');
const TeamHeadToHead = require('../models/TeamHeadToHead');
const User = require('../models/User');
const authenticateJWT = require('../middleware/authJWT');
const requireAdmin = require('../middleware/requireAdmin');

// Normalize pair: always store smaller userId first for consistent lookup
const normalizePair = (id1, id2) => {
  if (!id1 || !id2) return null;
  const s1 = id1.toString();
  const s2 = id2.toString();
  return s1 < s2 ? [id1, id2] : [id2, id1];
};

// Normalize team name for matching
const normalizeTeamName = (name) =>
  String(name || '').replace(/\p{Emoji}/gu, '').trim().toLowerCase().replace(/\s+(xi|11|cpl)$/i, '').trim();

// Compute head-to-head from Fixture, MatchResult, PlayoffFixture
const computeHeadToHeadFromSource = async () => {
  const users = await User.find({ isActive: true, teamName: { $exists: true, $ne: null } }).select('_id teamName').lean();
  const teamNameToUser = new Map();
  users.forEach((u) => {
    if (!u.teamName) return;
    const n = normalizeTeamName(u.teamName);
    teamNameToUser.set(n, u);
    teamNameToUser.set(String(u.teamName).trim(), u);
    teamNameToUser.set(String(u.teamName).trim().toLowerCase(), u);
  });

  const resolveToUser = (name) => {
    if (!name) return null;
    return teamNameToUser.get(normalizeTeamName(name)) || teamNameToUser.get(String(name).trim()) || teamNameToUser.get(String(name).trim().toLowerCase()) || null;
  };

  const h2hMap = new Map();

  const addWin = (uid1, uid2, winnerUid, team1Name, team2Name) => {
    const pair = normalizePair(uid1, uid2);
    if (!pair) return;
    const [id1, id2] = pair;
    const key = `${id1}|${id2}`;
    if (!h2hMap.has(key)) {
      const n1 = id1.toString();
      const n2 = id2.toString();
      const u1 = users.find((u) => u._id.toString() === n1);
      const u2 = users.find((u) => u._id.toString() === n2);
      h2hMap.set(key, {
        team1UserId: id1,
        team2UserId: id2,
        team1Name: u1?.teamName || team1Name,
        team2Name: u2?.teamName || team2Name,
        team1Wins: 0,
        team2Wins: 0,
        draws: 0,
      });
    }
    const r = h2hMap.get(key);
    if (winnerUid && winnerUid.toString() === id1.toString()) r.team1Wins++;
    else if (winnerUid && winnerUid.toString() === id2.toString()) r.team2Wins++;
    else r.draws++;
  };

  const [fixtures, matchResults, playoffs] = await Promise.all([
    Fixture.find({ isActive: true, winner: { $exists: true, $ne: null, $ne: '' } }).select('team1 team2 team1UserId team2UserId winner').lean(),
    MatchResult.find({ winner: { $in: ['team1', 'team2'] } }).select('team1 team2 winner').lean(),
    PlayoffFixture.find({ isCompleted: true, winner: { $exists: true, $ne: null, $ne: '' } })
      .select('team1 team2 team1UserId team2UserId winner')
      .lean(),
  ]);

  for (const f of fixtures) {
    if (f.winner !== f.team1 && f.winner !== f.team2) continue;
    let u1 = f.team1UserId ? { _id: f.team1UserId, teamName: f.team1 } : resolveToUser(f.team1);
    let u2 = f.team2UserId ? { _id: f.team2UserId, teamName: f.team2 } : resolveToUser(f.team2);
    if (!u1 || !u2) continue;
    const winnerUid = f.winner === f.team1 ? u1._id : u2._id;
    addWin(u1._id, u2._id, winnerUid, f.team1, f.team2);
  }

  for (const m of matchResults) {
    const u1 = resolveToUser(m.team1);
    const u2 = resolveToUser(m.team2);
    if (!u1 || !u2) continue;
    const winnerUid = m.winner === 'team1' ? u1._id : u2._id;
    addWin(u1._id, u2._id, winnerUid, m.team1, m.team2);
  }

  for (const p of playoffs) {
    if (String(p.team1 || '').includes('Winner of') || String(p.team2 || '').includes('Winner of')) continue;
    if (p.winner !== p.team1 && p.winner !== p.team2) continue;
    let u1 = p.team1UserId ? { _id: p.team1UserId, teamName: p.team1 } : resolveToUser(p.team1);
    let u2 = p.team2UserId ? { _id: p.team2UserId, teamName: p.team2 } : resolveToUser(p.team2);
    if (!u1 || !u2) continue;
    const winnerUid = p.winner === p.team1 ? u1._id : u2._id;
    addWin(u1._id, u2._id, winnerUid, p.team1, p.team2);
  }

  return [...h2hMap.values()].filter((r) => (r.team1Wins || 0) + (r.team2Wins || 0) > 0);
};

// Sync head-to-head: rebuild TeamHeadToHead from Fixture, MatchResult, PlayoffFixture. No duplicates.
const syncHeadToHead = async () => {
  const records = await computeHeadToHeadFromSource();
  await TeamHeadToHead.deleteMany({});
  if (records.length > 0) {
    await TeamHeadToHead.insertMany(records.map((r) => ({
      team1UserId: r.team1UserId,
      team2UserId: r.team2UserId,
      team1Name: r.team1Name,
      team2Name: r.team2Name,
      team1Wins: r.team1Wins || 0,
      team2Wins: r.team2Wins || 0,
      draws: r.draws || 0,
    })));
  }
  return records.length;
};

// No-op: full rebuild on sync handles winner changes
const revertAndResyncForRecord = async () => syncHeadToHead();

// GET /api/head-to-head - Read from TeamHeadToHead (sync runs when fixture/match/playoff saved)
router.get('/', async (req, res) => {
  try {
    const count = await TeamHeadToHead.countDocuments();
    const synced = count === 0 ? await syncHeadToHead() : 0;
    const records = await TeamHeadToHead.find()
      .populate('team1UserId', 'teamName')
      .populate('team2UserId', 'teamName')
      .sort({ team1Name: 1, team2Name: 1 })
      .lean();

    const mapped = records
      .map((r) => ({
        team1UserId: r.team1UserId?._id || r.team1UserId,
        team2UserId: r.team2UserId?._id || r.team2UserId,
        team1Name: r.team1Name || r.team1UserId?.teamName,
        team2Name: r.team2Name || r.team2UserId?.teamName,
        team1Wins: r.team1Wins || 0,
        team2Wins: r.team2Wins || 0,
        draws: r.draws || 0,
      }))
      .filter((r) => (r.team1Wins || 0) + (r.team2Wins || 0) > 0);

    res.json({ records: mapped, syncedCount: synced });
  } catch (error) {
    console.error('Head-to-head fetch error:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch head-to-head' });
  }
});

// GET /api/head-to-head/matches/:team1Id/:team2Id - All matches between two teams (scorecard)
router.get('/matches/:team1Id/:team2Id', async (req, res) => {
  try {
    const { team1Id, team2Id } = req.params;
    const [u1, u2] = await Promise.all([
      User.findById(team1Id).select('teamName').lean(),
      User.findById(team2Id).select('teamName').lean(),
    ]);
    if (!u1 || !u2) {
      return res.status(404).json({ message: 'One or both teams not found' });
    }
    const t1 = u1.teamName;
    const t2 = u2.teamName;
    const n1 = normalizeTeamName(t1);
    const n2 = normalizeTeamName(t2);
    if (!n1 || !n2) {
      return res.status(400).json({ message: 'Invalid team names' });
    }

    // Fetch from all sources - use broad queries then filter in memory for reliable matching
    const [allFixtures, allMatchResults, allPlayoffFixtures] = await Promise.all([
      Fixture.find({
        isActive: true,
        $or: [
          { winner: { $exists: true, $ne: null, $ne: '' } },
          { team1Score: { $exists: true, $ne: null, $ne: '' }, team2Score: { $exists: true, $ne: null, $ne: '' } },
        ],
      })
        .sort({ createdAt: -1 })
        .lean(),
      MatchResult.find({ winner: { $in: ['team1', 'team2'] } }).sort({ matchDate: -1 }).lean(),
      PlayoffFixture.find({
        isCompleted: true,
        $or: [
          { winner: { $exists: true, $ne: null, $ne: '' } },
          { team1Score: { $exists: true, $ne: null, $ne: '' }, team2Score: { $exists: true, $ne: null, $ne: '' } },
        ],
      })
        .sort({ date: -1 })
        .lean(),
    ]);

    const isMatch = (mTeam1, mTeam2) => {
      const mn1 = normalizeTeamName(mTeam1);
      const mn2 = normalizeTeamName(mTeam2);
      return (mn1 === n1 && mn2 === n2) || (mn1 === n2 && mn2 === n1);
    };

    const fixtures = allFixtures.filter((f) => {
      if (!isMatch(f.team1, f.team2)) return false;
      const w = normalizeTeamName(f.winner);
      if (w === n1 || w === n2) return true;
      if (f.team1Score && f.team2Score) return true;
      return false;
    });
    const matchResults = allMatchResults.filter((m) => isMatch(m.team1, m.team2));
    const playoffFixtures = allPlayoffFixtures.filter((p) => {
      if (!isMatch(p.team1, p.team2)) return false;
      const w = normalizeTeamName(p.winner);
      if (w === n1 || w === n2) return true;
      if (p.team1Score && p.team2Score && p.team1Score !== 'TBD' && p.team2Score !== 'TBD') return true;
      return false;
    });

    const normalizeForKey = (name) => String(name || '').replace(/\p{Emoji}/gu, '').trim();
    const matchKey = (m) => {
      const t1 = normalizeForKey(m.team1);
      const t2 = normalizeForKey(m.team2);
      const pair = [t1, t2].sort().join('|');
      return `${pair}|${m.team1Score}|${m.team2Score}`;
    };
    const getWinner = (f) => {
      if (f.winner) return f.winner;
      const s1 = parseInt(f.team1Score, 10);
      const s2 = parseInt(f.team2Score, 10);
      if (!isNaN(s1) && !isNaN(s2)) return s1 > s2 ? f.team1 : s2 > s1 ? f.team2 : null;
      return null;
    };
    const rawMatches = [
      ...fixtures.map((f) => ({
        source: 'fixture',
        team1: f.team1,
        team2: f.team2,
        team1Score: f.team1Score || '-',
        team2Score: f.team2Score || '-',
        winner: getWinner(f) || f.winner,
        margin: f.margin || null,
        date: f.createdAt,
      })),
      ...matchResults.map((m) => {
        const winnerName = m.winner === 'team1' ? m.team1 : m.team2;
        const team1Score = `${m.team1Score || 0}/${m.team1Wickets || 0}`;
        const team2Score = `${m.team2Score || 0}/${m.team2Wickets || 0}`;
        return {
          source: 'match',
          team1: m.team1,
          team2: m.team2,
          team1Score,
          team2Score,
          winner: winnerName,
          margin: m.margin || null,
          date: m.matchDate || m.createdAt,
        };
      }),
      ...playoffFixtures.map((p) => ({
        source: 'playoff',
        team1: p.team1,
        team2: p.team2,
        team1Score: p.team1Score || '-',
        team2Score: p.team2Score || '-',
        winner: p.winner,
        margin: p.margin || null,
        date: p.date || p.updatedAt,
      })),
    ];
    // Deduplicate: same teams + scores = same match (e.g. 8th Match vs 9th Match from different DBs)
    const seen = new Set();
    const matches = rawMatches
      .filter((m) => {
        const k = matchKey(m);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      team1: t1,
      team2: t2,
      matches,
    });
  } catch (error) {
    console.error('Head-to-head matches error:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch matches' });
  }
});

// POST /api/head-to-head/sync - Manually trigger sync (e.g. after bulk fixture update)
router.post('/sync', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    const synced = await syncHeadToHead();
    res.json({ message: `Synced ${synced} new results`, syncedCount: synced });
  } catch (error) {
    console.error('Head-to-head sync error:', error);
    res.status(500).json({ message: error.message || 'Sync failed' });
  }
});

// POST /api/head-to-head/reset - Clear TeamHeadToHead and re-sync from Fixture, MatchResult, PlayoffFixture
router.post('/reset', authenticateJWT, requireAdmin, async (req, res) => {
  try {
    await TeamHeadToHead.deleteMany({});
    const synced = await syncHeadToHead();
    res.json({ message: 'Reset and re-synced TeamHeadToHead', syncedCount: synced });
  } catch (error) {
    console.error('Head-to-head reset error:', error);
    res.status(500).json({ message: error.message || 'Reset failed' });
  }
});

module.exports = router;
module.exports.syncHeadToHead = syncHeadToHead;
module.exports.revertAndResyncForRecord = revertAndResyncForRecord;
