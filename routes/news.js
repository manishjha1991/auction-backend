const express = require('express');
const router = express.Router();
const TradeRequest = require('../models/TradeRequest');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const PlayerStats = require('../models/PlayerStats');
const Player = require('../models/Player');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Fixture = require('../models/Fixture');

function toCrores(amount) {
  const n = Number(amount || 0);
  return n / 10000000;
}

function pickVariant(seed, options) {
  try {
    const s = String(seed || '');
    const sum = Array.from(s).reduce((a, c) => a + c.charCodeAt(0), 0);
    return options[sum % options.length];
  } catch {
    return options[0];
  }
}

router.get('/feed', async (_req, res) => {
  try {
    const [trades, releases, picks, recentStats, fixtures] = await Promise.all([
      TradeRequest.find({}).populate('fromUser toUser offeredPlayer requestedPlayer').sort({ updatedAt: -1 }).limit(30).lean(),
      ReleaseRequest.find({}).populate('user', 'teamName').populate('player', 'name type').sort({ updatedAt: -1 }).limit(30).lean(),
      PickRequest.find({}).populate('user', 'teamName').populate('player', 'name type basePrice').sort({ updatedAt: -1 }).limit(30).lean(),
      PlayerStats.find({}).sort({ createdAt: -1 }).limit(50).lean(),
      Fixture.find({ isActive: true, winner: { $ne: null } }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    const news = [];

    // Trades
    for (const t of trades) {
      const offeredName = t.offeredPlayer?.name || 'Player A';
      const requestedName = t.requestedPlayer?.name || 'Player B';
      const fromTeam = t.fromUser?.teamName || 'Team A';
      const toTeam = t.toUser?.teamName || 'Team B';
      // Try to infer trade value from user-player bid values
      let approxValue = 0;
      try {
        const [up1, up2] = await Promise.all([
          UserPlayer.findOne({ playerId: t.offeredPlayer?._id, isActive: true }).lean(),
          UserPlayer.findOne({ playerId: t.requestedPlayer?._id, isActive: true }).lean(),
        ]);
        approxValue = Math.max(Number(up1?.bidValue || 0), Number(up2?.bidValue || 0));
      } catch {}

      let status = t.status;
      let title = '';
      let body = '';
      const priceCr = toCrores(approxValue).toFixed(2);
      const highValue = approxValue >= 100000000; // 10 cr
      if (status === 'completed') {
        title = `Trade Confirmed: ${offeredName} ↔ ${requestedName}`;
        body = `${fromTeam} and ${toTeam} completed a swap${approxValue ? ` (approx ₹${priceCr} Cr)` : ''}.`;
      } else if (status === 'admin_pending') {
        title = `Awaiting Approval: ${offeredName} ↔ ${requestedName}`;
        body = `Trade sent to admin by ${toTeam}. ${fromTeam} initiated the proposal.`;
      } else if (status === 'pending' || status === 'counter') {
        title = `Trade Proposed: ${offeredName} ↔ ${requestedName}`;
        body = `${fromTeam} proposed a trade to ${toTeam}.`;
      } else if (status === 'rejected') {
        title = `Trade Rejected: ${offeredName} ↔ ${requestedName}`;
        body = `Admin/user rejected the proposal.`;
      } else if (status === 'withdrawn') {
        title = `Trade Withdrawn: ${offeredName} ↔ ${requestedName}`;
        body = `${fromTeam} withdrew the proposal.`;
      }
      news.push({
        kind: 'trade',
        status,
        title,
        body,
        isBreaking: status === 'completed' && highValue,
        timestamp: t.updatedAt,
      });
    }

    // Releases
    for (const r of releases) {
      let title = '';
      let body = '';
      if (r.status === 'completed') {
        title = `Release Confirmed: ${r.player?.name}`;
        body = `${r.user?.teamName} released ${r.player?.name} (${r.player?.type}).`;
      } else if (r.status === 'pending' || r.status === 'admin_pending') {
        title = `Release Requested: ${r.player?.name}`;
        body = `${r.user?.teamName} requested to release ${r.player?.name}.`;
      } else if (r.status === 'rejected') {
        title = `Release Rejected: ${r.player?.name}`;
        body = `Admin rejected release for ${r.player?.name}.`;
      }
      news.push({ kind: 'release', status: r.status, title, body, isBreaking: false, timestamp: r.updatedAt });
    }

    // Picks
    for (const p of picks) {
      let title = '';
      let body = '';
      if (p.status === 'completed') {
        title = `Pick Confirmed: ${p.player?.name} to ${p.user?.teamName}`;
        body = `${p.player?.type} picked at base ₹${Number(p.player?.basePrice || 0).toLocaleString('en-IN')}.`;
      } else if (p.status === 'pending' || p.status === 'admin_pending') {
        title = `Pick Requested: ${p.player?.name}`;
        body = `${p.user?.teamName} requested to pick unsold ${p.player?.type}.`;
      } else if (p.status === 'rejected') {
        title = `Pick Rejected: ${p.player?.name}`;
        body = `Admin rejected pick request from ${p.user?.teamName}.`;
      }
      news.push({ kind: 'pick', status: p.status, title, body, isBreaking: false, timestamp: p.updatedAt });
    }

    // Stats highlights (centuries, 50+, 4-fers, all-round)
    for (const s of recentStats) {
      const runs = s.battingStats?.runs || 0;
      const wickets = s.bowlingStats?.wickets || 0;
      const ballsBowled = s.bowlingStats?.ballsBowled || 0;
      const [player, user, opp] = await Promise.all([
        Player.findById(s.playerId).select('name type').lean(),
        User.findById(s.userId).select('teamName').lean(),
        s.opponentUserId ? User.findById(s.opponentUserId).select('teamName').lean() : Promise.resolve(null),
      ]);

      // All-round performance
      if (runs >= 20 && wickets >= 3) {
        news.push({
          kind: 'stats',
          status: 'all_round',
          title: `All-round brilliance: ${player?.name} ${runs}+ & ${wickets} for ${user?.teamName}`,
          body: `Against ${opp?.teamName || 'opposition'}, ${player?.name} contributed ${runs} runs and bagged ${wickets} wickets.`,
          isBreaking: true,
          timestamp: s.createdAt,
        });
        continue; // avoid multiple entries for same doc
      }

      // Batting milestones
      if (runs >= 100) {
        const phrases = [
          `thunders to a ${runs} for ${user?.teamName}`,
          `lights up the park with ${runs}`,
          `hammers a majestic ${runs}`,
        ];
        news.push({
          kind: 'stats',
          status: 'century',
          title: `Breaking: ${player?.name} ${pickVariant(player?.name + runs, phrases)}`,
          body: `Century against ${opp?.teamName || 'opposition'}.`,
          isBreaking: true,
          timestamp: s.createdAt,
        });
      } else if (runs >= 50) {
        const phrases = [
          `crafts a classy ${runs} for ${user?.teamName}`,
          `anchors with a composed ${runs}`,
          `raises a fine fifty (${runs})`,
        ];
        news.push({
          kind: 'stats',
          status: 'fifty',
          title: `${player?.name} ${pickVariant(player?.name + runs, phrases)}`,
          body: `Half-century against ${opp?.teamName || 'opposition'}.`,
          isBreaking: false,
          timestamp: s.createdAt,
        });
      }

      // Bowling milestones
      if (wickets >= 5) {
        const phrases = [
          `wrecks ${opp?.teamName || 'opposition'} with ${wickets}`,
          `delivers a devastating ${wickets}-for`,
          `runs riot with ${wickets} wickets`,
        ];
        news.push({
          kind: 'stats',
          status: 'fifer',
          title: `Breaking: ${player?.name} ${pickVariant(player?.name + wickets, phrases)}`,
          body: `Spell of the day for ${user?.teamName}.`,
          isBreaking: true,
          timestamp: s.createdAt,
        });
      } else if (wickets >= 4) {
        const phrases = [
          `stuns with ${wickets} wickets for ${user?.teamName}`,
          `produces a superb ${wickets}-for`,
          `cripples ${opp?.teamName || 'opposition'} with ${wickets}`,
        ];
        news.push({
          kind: 'stats',
          status: 'four_wkt',
          title: `${player?.name} ${pickVariant(player?.name + wickets, phrases)}`,
          body: `Bowling masterclass.`,
          isBreaking: false,
          timestamp: s.createdAt,
        });
      }
    }

    // Fixtures: generate result statements and praise MoM
    for (const f of fixtures) {
      const thriller = (() => {
        // Heuristic: small margin or tied scores → thriller
        if (!f.margin) return false;
        const text = String(f.margin).toLowerCase();
        return text.includes('wicket') && /\b(1|2)\b/.test(text) || text.includes('run') && /\b(1|2|3|4|5)\b/.test(text);
      })();
      const oneSided = (() => {
        if (!f.margin) return false;
        const text = String(f.margin).toLowerCase();
        return text.includes('wicket') && /\b(8|9|10)\b/.test(text) || text.includes('run') && /\b(40|50|60|70|80|90|100)\b/.test(text);
      })();
      const opponent = f.team1 === f.winner ? f.team2 : f.team1;
      const titleVariantsThriller = [
        `${f.winner} edge past ${opponent} in a last-over thriller`,
        `${f.winner} clinch a nail-biter against ${opponent}`,
        `${f.winner} prevail by a whisker vs ${opponent}`,
      ];
      const titleVariantsOneSided = [
        `${f.winner} crush ${opponent} in a one-sided affair`,
        `${f.winner} dominate ${opponent} from start to finish`,
        `${f.winner} steamroll ${opponent}`,
      ];
      const titleVariantsRegular = [
        `${f.winner} beat ${opponent} in style`,
        `${f.winner} outplay ${opponent}`,
        `${f.winner} record solid win over ${opponent}`,
      ];
      let title = pickVariant(`${f.team1}-${f.team2}-${f.createdAt}`, thriller ? titleVariantsThriller : oneSided ? titleVariantsOneSided : titleVariantsRegular);

      const momText = f.mom?.name ? ` MoM ${f.mom.name}${(f.mom.score ? ` scored ${f.mom.score}` : '')}${(f.mom.wickets ? ` and took ${f.mom.wickets} wickets` : '')}.` : '';
      const scoreLine = (f.team1Score && f.team2Score) ? ` ${f.team1} ${f.team1Score} vs ${f.team2} ${f.team2Score}.` : '';
      const bodyVariants = [
        `${f.margin ? `Won by ${f.margin}.` : ''}${scoreLine}${momText}`.trim(),
        `${scoreLine}${f.margin ? ` Victory margin: ${f.margin}.` : ''}${momText}`.trim(),
        `${momText}${scoreLine}${f.margin ? ` (${f.margin}).` : ''}`.trim(),
      ];
      news.push({
        kind: 'fixture',
        status: thriller ? 'thriller' : oneSided ? 'one_sided' : 'result',
        title,
        body: pickVariant(`${f.team1}-${f.team2}-${f.updatedAt}`, bodyVariants),
        isBreaking: thriller,
        timestamp: f.createdAt,
      });
    }

    // Sort by timestamp desc and cap
    news.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ items: news.slice(0, 100) });
  } catch (e) {
    console.error('Error building news feed', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


