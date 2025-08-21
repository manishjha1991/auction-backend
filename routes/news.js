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
      TradeRequest.find({})
        .populate('fromUser', 'name teamName')
        .populate('toUser', 'name teamName')
        .populate('offeredPlayer', 'name type role')
        .populate('requestedPlayer', 'name type role')
        .sort({ updatedAt: -1 })
        .limit(50), // Increased limit to show more trades
      ReleaseRequest.find({})
        .populate({
          path: 'user',
          select: 'teamName',
          model: 'User'
        })
        .populate({
          path: 'player',
          select: 'name type',
          model: 'Player'
        })
        .sort({ updatedAt: -1 })
        .limit(30),
      PickRequest.find({})
        .populate('user', 'teamName')
        .populate('player', 'name type basePrice')
        .sort({ updatedAt: -1 })
        .limit(30),
      PlayerStats.find({}).sort({ createdAt: -1 }).limit(50).lean(),
      Fixture.find({ isActive: true, winner: { $ne: null } }).sort({ createdAt: -1 }).limit(20).lean()
    ]);

    // Test query to see raw data
    try {
      const rawReleases = await ReleaseRequest.find({ status: 'withdrawn' }).limit(5);
      console.log('🔍 Raw withdrawn releases (no population):', rawReleases.map(r => ({
        id: r._id,
        status: r.status,
        userId: r.user,
        playerId: r.player,
        updatedAt: r.updatedAt
      })));
    } catch (error) {
      console.error('❌ Raw query failed:', error);
    }

    // Debug logging
    console.log('🔍 News Feed - Trades found:', trades.length);
    console.log('🔍 News Feed - Releases found:', releases.length);
    console.log('🔍 News Feed - Picks found:', picks.length);
    console.log('🔍 News Feed - Sample trade:', trades[0]);
    console.log('🔍 News Feed - Sample release:', releases[0]);
    console.log('🔍 News Feed - Sample pick:', picks[0]);

    const news = [];

    // Trades
    for (const t of trades) {
      // Debug individual trade
      console.log('🔍 Processing trade:', {
        id: t._id,
        status: t.status,
        fromUser: t.fromUser,
        toUser: t.toUser,
        offeredPlayer: t.offeredPlayer,
        requestedPlayer: t.requestedPlayer
      });

      const offeredName = t.offeredPlayer?.name || 'Unknown Player';
      const requestedName = t.requestedPlayer?.name || 'Unknown Player';
      const fromTeam = t.fromUser?.teamName || 'Unknown Team';
      const toTeam = t.toUser?.teamName || 'Unknown Team';
      
      console.log('🔍 Extracted names:', { offeredName, requestedName, fromTeam, toTeam });
      
      // Try to infer trade value from user-player bid values
      let approxValue = 0;
      try {
        const [up1, up2] = await Promise.all([
          UserPlayer.findOne({ playerId: t.offeredPlayer?._id, isActive: true }).lean(),
          UserPlayer.findOne({ playerId: t.requestedPlayer?._id, isActive: true }).lean(),
        ]);
        approxValue = Math.max(Number(up1?.bidValue || 0), Number(up2?.bidValue || 0));
      } catch (error) {
        console.error('Error getting bid values for trade:', error);
      }

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
      // Debug individual release with full object
      console.log('🔍 Processing release - FULL OBJECT:', JSON.stringify(r, null, 2));
      console.log('🔍 Processing release - ID:', r._id);
      console.log('🔍 Processing release - Status:', r.status);
      console.log('🔍 Processing release - User object:', r.user);
      console.log('🔍 Processing release - Player object:', r.player);
      console.log('🔍 Processing release - User ID:', r.user?._id);
      console.log('🔍 Processing release - Player ID:', r.player?._id);

      let title = '';
      let body = '';
      
      // Check if population worked and try manual fallback if needed
      let userData = r.user;
      let playerData = r.player;
      
      if (!userData || !playerData) {
        console.log('⚠️ Population failed for release:', r._id);
        console.log('⚠️ User populated:', !!userData);
        console.log('⚠️ Player populated:', !!playerData);
        
        // Try manual fallback - fetch data directly
        try {
          if (!userData && r.user) {
            const user = await User.findById(r.user).select('teamName').lean();
            userData = user;
            console.log('🔄 Manual user fetch result:', userData);
          }
          
          if (!playerData && r.player) {
            const player = await Player.findById(r.player).select('name type').lean();
            playerData = player;
            console.log('🔄 Manual player fetch result:', playerData);
          }
        } catch (error) {
          console.error('❌ Manual fetch failed:', error);
        }
      }
      
      if (r.status === 'completed') {
        title = `Release Confirmed: ${playerData?.name || 'Unknown Player'}`;
        body = `${userData?.teamName || 'Unknown Team'} released ${playerData?.name || 'Unknown Player'} (${playerData?.type || 'Unknown Type'}).`;
      } else if (r.status === 'pending' || r.status === 'admin_pending') {
        title = `Release Requested: ${playerData?.name || 'Unknown Player'}`;
        body = `${userData?.teamName || 'Unknown Team'} requested to release ${playerData?.name || 'Unknown Player'}.`;
      } else if (r.status === 'rejected') {
        title = `Release Rejected: ${playerData?.name || 'Unknown Player'}`;
        body = `Admin rejected release for ${playerData?.name || 'Unknown Player'}.`;
      } else if (r.status === 'withdrawn') {
        title = `Release Withdrawn: ${playerData?.name || 'Unknown Player'}`;
        body = `${userData?.teamName || 'Unknown Team'} withdrew the release request for ${playerData?.name || 'Unknown Player'}.`;
      }
      
      console.log('🔍 Release title/body:', { title, body });
      
      // Only add to news if we have a valid title and body
      if (title && body) {
        news.push({ 
          kind: 'release', 
          status: r.status, 
          title, 
          body, 
          isBreaking: false, 
          timestamp: r.updatedAt 
        });
      } else {
        console.log('❌ Skipping release due to empty title/body:', { id: r._id, status: r.status, title, body });
      }
    }

    // Picks
    for (const p of picks) {
      // Debug individual pick
      console.log('🔍 Processing pick:', {
        id: p._id,
        status: p.status,
        user: p.user,
        player: p.player
      });

      let title = '';
      let body = '';
      if (p.status === 'completed') {
        title = `Pick Confirmed: ${p.player?.name || 'Unknown Player'} to ${p.user?.teamName || 'Unknown Team'}`;
        body = `${p.player?.type || 'Unknown Type'} picked at base ₹${Number(p.player?.basePrice || 0).toLocaleString('en-IN')}.`;
      } else if (p.status === 'pending' || p.status === 'admin_pending') {
        title = `Pick Requested: ${p.player?.name || 'Unknown Player'}`;
        body = `${p.user?.teamName || 'Unknown Team'} requested to pick unsold ${p.player?.type || 'Unknown Type'}.`;
      } else if (p.status === 'rejected') {
        title = `Pick Rejected: ${p.player?.name || 'Unknown Player'}`;
        body = `Admin rejected pick request from ${p.user?.teamName || 'Unknown Team'}.`;
      }
      
      console.log('🔍 Pick title/body:', { title, body });
      
      news.push({ 
        kind: 'pick', 
        status: p.status, 
        title, 
        body, 
        isBreaking: false, 
        timestamp: p.updatedAt 
      });
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
    
    // Summary logging
    const tradeCount = news.filter(n => n.kind === 'trade').length;
    const releaseCount = news.filter(n => n.kind === 'release').length;
    const pickCount = news.filter(n => n.kind === 'pick').length;
    const statsCount = news.filter(n => n.kind === 'stats').length;
    const fixtureCount = news.filter(n => n.kind === 'fixture').length;
    
    console.log('📰 News Feed Summary:', {
      total: news.length,
      trades: tradeCount,
      releases: releaseCount,
      picks: pickCount,
      stats: statsCount,
      fixtures: fixtureCount
    });
    
    res.json({ items: news.slice(0, 100) });
  } catch (e) {
    console.error('Error building news feed', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


