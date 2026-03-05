const express = require('express');
const router = express.Router();
const Fixture = require('../models/Fixture');
const MatchResult = require('../models/MatchResult');
const PlayoffFixture = require('../models/PlayoffFixture');
const TeamHeadToHead = require('../models/TeamHeadToHead');
const User = require('../models/User');

// Normalize pair: always store smaller userId first for consistent lookup
const normalizePair = (id1, id2) => {
  if (!id1 || !id2) return null;
  const s1 = id1.toString();
  const s2 = id2.toString();
  return s1 < s2 ? [id1, id2] : [id2, id1];
};

// Sync head-to-head from fixtures and match results (incremental - only unsynced)
const syncHeadToHead = async () => {
  const UserModel = User;
  let synced = 0;

  // 1. Fixtures with winner, not yet synced
  // Only sync when winner is explicitly team1 or team2 (avoid blank/placeholder fixtures)
  const unsyncedFixtures = await Fixture.find({
    winner: { $exists: true, $ne: null, $ne: '' },
    headToHeadSynced: { $ne: true }
  }).lean();

  const fixturesWithValidWinner = unsyncedFixtures.filter(
    (f) => f.winner && (f.winner === f.team1 || f.winner === f.team2)
  );

  for (const f of fixturesWithValidWinner) {
    let uid1 = f.team1UserId;
    let uid2 = f.team2UserId;
    if (!uid1 && f.team1) {
      const u = await UserModel.findOne({ teamName: f.team1, isActive: true }).select('_id teamName').lean();
      uid1 = u?._id;
    }
    if (!uid2 && f.team2) {
      const u = await UserModel.findOne({ teamName: f.team2, isActive: true }).select('_id teamName').lean();
      uid2 = u?._id;
    }
    const pair = normalizePair(uid1, uid2);
    if (!pair) continue;

    const [teamAId, teamBId] = pair;
    const teamAName = uid1?.toString() === teamAId.toString() ? f.team1 : f.team2;
    const teamBName = uid2?.toString() === teamBId.toString() ? f.team2 : f.team1;

    const winnerUserId = f.winner === f.team1 ? uid1 : uid2;
    const winnerIsFirst = winnerUserId?.toString() === teamAId.toString();

    await TeamHeadToHead.findOneAndUpdate(
      { team1UserId: teamAId, team2UserId: teamBId },
      {
        $inc: {
          team1Wins: winnerIsFirst ? 1 : 0,
          team2Wins: winnerIsFirst ? 0 : 1,
          draws: 0
        },
        $set: {
          team1Name: teamAName,
          team2Name: teamBName,
          lastSyncedAt: new Date()
        }
      },
      { upsert: true }
    );

    await Fixture.updateOne({ _id: f._id }, { $set: { headToHeadSynced: true } });
    synced++;
  }

  // 2. Match results with winner (team1 or team2), not tie/no_result, not yet synced
  const unsyncedMatches = await MatchResult.find({
    winner: { $in: ['team1', 'team2'] },
    headToHeadSynced: { $ne: true }
  }).lean();

  for (const m of unsyncedMatches) {
    const u1 = await UserModel.findOne({ teamName: m.team1, isActive: true }).select('_id teamName').lean();
    const u2 = await UserModel.findOne({ teamName: m.team2, isActive: true }).select('_id teamName').lean();
    if (!u1 || !u2) continue;

    const pair = normalizePair(u1._id, u2._id);
    if (!pair) continue;

    const [teamAId, teamBId] = pair;
    const teamAName = u1._id.toString() === teamAId.toString() ? u1.teamName : u2.teamName;
    const teamBName = u2._id.toString() === teamBId.toString() ? u2.teamName : u1.teamName;

    const winnerUserId = m.winner === 'team1' ? u1._id : u2._id;
    const winnerIsFirst = winnerUserId.toString() === teamAId.toString();

    await TeamHeadToHead.findOneAndUpdate(
      { team1UserId: teamAId, team2UserId: teamBId },
      {
        $inc: {
          team1Wins: winnerIsFirst ? 1 : 0,
          team2Wins: winnerIsFirst ? 0 : 1,
          draws: 0
        },
        $set: {
          team1Name: teamAName,
          team2Name: teamBName,
          lastSyncedAt: new Date()
        }
      },
      { upsert: true }
    );

    await MatchResult.updateOne({ _id: m._id }, { $set: { headToHeadSynced: true } });
    synced++;
  }

  // 3. Playoff fixtures with winner (team1 or team2), not yet synced
  const unsyncedPlayoffs = await PlayoffFixture.find({
    isCompleted: true,
    winner: { $exists: true, $ne: null, $ne: '' },
    headToHeadSynced: { $ne: true }
  }).lean();

  const playoffsWithValidWinner = unsyncedPlayoffs.filter(
    (p) => p.winner && (p.winner === p.team1 || p.winner === p.team2) &&
      !String(p.team1 || '').includes('Winner of') && !String(p.team1 || '').includes('Loser of') &&
      !String(p.team2 || '').includes('Winner of') && !String(p.team2 || '').includes('Loser of')
  );

  for (const p of playoffsWithValidWinner) {
    let uid1 = p.team1UserId;
    let uid2 = p.team2UserId;
    const findUserByTeamName = async (name) => {
      if (!name) return null;
      const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let u = await UserModel.findOne({ teamName: name, isActive: true }).select('_id teamName').lean();
      if (!u) u = await UserModel.findOne({ teamName: { $regex: new RegExp(`^${esc(name)}$`), $options: 'i' }, isActive: true }).select('_id teamName').lean();
      if (!u) {
        const base = String(name).replace(/\s+(XI|11|CPL)$/i, '').trim();
        if (base) u = await UserModel.findOne({ teamName: { $regex: new RegExp(`^${esc(base)}(\\s+XI|\\s+11|\\s+CPL)?$`, 'i') }, isActive: true }).select('_id teamName').lean();
      }
      return u?._id;
    };
    if (!uid1 && p.team1) uid1 = await findUserByTeamName(p.team1);
    if (!uid2 && p.team2) uid2 = await findUserByTeamName(p.team2);
    const pair = normalizePair(uid1, uid2);
    if (!pair) continue;

    const [teamAId, teamBId] = pair;
    const teamAName = uid1?.toString() === teamAId.toString() ? p.team1 : p.team2;
    const teamBName = uid2?.toString() === teamBId.toString() ? p.team2 : p.team1;

    const winnerUserId = p.winner === p.team1 ? uid1 : uid2;
    const winnerIsFirst = winnerUserId?.toString() === teamAId.toString();

    await TeamHeadToHead.findOneAndUpdate(
      { team1UserId: teamAId, team2UserId: teamBId },
      {
        $inc: {
          team1Wins: winnerIsFirst ? 1 : 0,
          team2Wins: winnerIsFirst ? 0 : 1,
          draws: 0
        },
        $set: {
          team1Name: teamAName,
          team2Name: teamBName,
          lastSyncedAt: new Date()
        }
      },
      { upsert: true }
    );

    await PlayoffFixture.updateOne({ _id: p._id }, { $set: { headToHeadSynced: true } });
    synced++;
  }

  return synced;
};

// Revert one fixture/match result from H2H (when winner/teams changed) then re-sync
const revertAndResyncForRecord = async (team1Name, team2Name, oldWinnerTeamName) => {
  if (!team1Name || !team2Name || !oldWinnerTeamName || oldWinnerTeamName !== team1Name && oldWinnerTeamName !== team2Name) return 0;
  const u1 = await User.findOne({ teamName: team1Name, isActive: true }).select('_id').lean();
  const u2 = await User.findOne({ teamName: team2Name, isActive: true }).select('_id').lean();
  if (!u1 || !u2) return 0;
  const [id1, id2] = u1._id.toString() < u2._id.toString() ? [u1._id, u2._id] : [u2._id, u1._id];
  const winnerIsFirst = (oldWinnerTeamName === team1Name && u1._id.toString() === id1.toString()) || (oldWinnerTeamName === team2Name && u2._id.toString() === id1.toString());
  const filter = winnerIsFirst
    ? { team1UserId: id1, team2UserId: id2, team1Wins: { $gt: 0 } }
    : { team1UserId: id1, team2UserId: id2, team2Wins: { $gt: 0 } };
  await TeamHeadToHead.updateOne(filter, {
    $inc: { team1Wins: winnerIsFirst ? -1 : 0, team2Wins: winnerIsFirst ? 0 : -1 },
  });
  return syncHeadToHead();
};

// GET /api/head-to-head - Fetch all head-to-head records (runs sync first)
router.get('/', async (req, res) => {
  try {
    const synced = await syncHeadToHead();
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

// Normalize team name for matching: lowercase, trim, strip XI/11/CPL (so "Royals XI" === "Royals")
const normalizeTeamName = (name) =>
  String(name || '').replace(/\p{Emoji}/gu, '').trim().toLowerCase().replace(/\s+(xi|11|cpl)$/i, '').trim();

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
      Fixture.find({ isActive: true, winner: { $exists: true, $ne: null, $ne: '' } }).sort({ createdAt: -1 }).lean(),
      MatchResult.find({ winner: { $in: ['team1', 'team2'] } }).sort({ matchDate: -1 }).lean(),
      PlayoffFixture.find({ isCompleted: true, winner: { $exists: true, $ne: null, $ne: '' } }).sort({ date: -1 }).lean(),
    ]);

    const isMatch = (mTeam1, mTeam2) => {
      const mn1 = normalizeTeamName(mTeam1);
      const mn2 = normalizeTeamName(mTeam2);
      return (mn1 === n1 && mn2 === n2) || (mn1 === n2 && mn2 === n1);
    };

    const fixtures = allFixtures.filter((f) => isMatch(f.team1, f.team2) && (normalizeTeamName(f.winner) === n1 || normalizeTeamName(f.winner) === n2));
    const matchResults = allMatchResults.filter((m) => isMatch(m.team1, m.team2));
    const playoffFixtures = allPlayoffFixtures.filter((p) => isMatch(p.team1, p.team2) && (normalizeTeamName(p.winner) === n1 || normalizeTeamName(p.winner) === n2));

    const normalizeForKey = (name) => String(name || '').replace(/\p{Emoji}/gu, '').trim();
    const matchKey = (m) => {
      const t1 = normalizeForKey(m.team1);
      const t2 = normalizeForKey(m.team2);
      const pair = [t1, t2].sort().join('|');
      return `${pair}|${m.team1Score}|${m.team2Score}`;
    };
    const rawMatches = [
      ...fixtures.map((f) => ({
        source: 'fixture',
        team1: f.team1,
        team2: f.team2,
        team1Score: f.team1Score || '-',
        team2Score: f.team2Score || '-',
        winner: f.winner,
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
router.post('/sync', async (req, res) => {
  try {
    const synced = await syncHeadToHead();
    res.json({ message: `Synced ${synced} new results`, syncedCount: synced });
  } catch (error) {
    console.error('Head-to-head sync error:', error);
    res.status(500).json({ message: error.message || 'Sync failed' });
  }
});

// POST /api/head-to-head/reset - Clear all H2H data and re-sync from scratch (fixes bad data from blank fixtures)
router.post('/reset', async (req, res) => {
  try {
    await TeamHeadToHead.deleteMany({});
    await Fixture.updateMany({}, { $set: { headToHeadSynced: false } });
    await MatchResult.updateMany({}, { $set: { headToHeadSynced: false } });
    await PlayoffFixture.updateMany({}, { $set: { headToHeadSynced: false } });
    const synced = await syncHeadToHead();
    res.json({ message: 'Reset and re-synced', syncedCount: synced });
  } catch (error) {
    console.error('Head-to-head reset error:', error);
    res.status(500).json({ message: error.message || 'Reset failed' });
  }
});

module.exports = router;
module.exports.syncHeadToHead = syncHeadToHead;
module.exports.revertAndResyncForRecord = revertAndResyncForRecord;
