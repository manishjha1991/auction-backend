const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');

const PLAYING_XI_SIZE = 11;
const MIN_SILVER_IN_XI = 3;
const MAX_SAPPHIRE_IN_XI = 1;
const MAX_EMERALD_WITH_SAPPHIRE = 2;
const MAX_EMERALD_WITHOUT_SAPPHIRE = 3;

const ROLE_TARGETS = {
  Batsman: 3,
  Bowler: 3,
  Allrounder: 0,
  WicketKeeper: 1,
};

const CATEGORY_TARGETS = {
  Sapphire: 1,
  Gold: 0,
  Emerald: 0,
  Silver: 3,
};

const clampScore = (value) => Math.max(25, Math.min(98, Math.round(value)));

const detectBowlingType = (player) => {
  const style = (player?.style || '').toLowerCase();
  if (style.includes('spin')) return 'spin';
  if (style.includes('slow')) return 'spin';
  if (style.includes('medium') || style.includes('fast') || style.includes('pace')) return 'pace';
  return null;
};

const detectBattingHand = (player) => {
  const battingStyle = (player?.battingStyle || player?.style || '').toLowerCase();
  if (battingStyle.includes('left')) return 'left';
  if (battingStyle.includes('right')) return 'right';
  return null;
};

const buildRoleCounts = (players) => {
  const counts = {};
  players.forEach((player) => {
    const role = player?.role;
    if (!role) return;
    counts[role] = (counts[role] || 0) + 1;
  });
  return counts;
};

const getActiveRoster = async (userId) => {
  return UserPlayer.find({ userId, isActive: true })
    .populate('playerId', 'name role type style battingStyle overallScore');
};

const computeBreakdown = (rosterDocs = []) => {
  const breakdown = {
    totalPlayers: rosterDocs.length,
    categories: { Sapphire: 0, Gold: 0, Emerald: 0, Silver: 0 },
    roles: { Batsman: 0, Bowler: 0, Allrounder: 0, WicketKeeper: 0 },
    styles: { left: 0, right: 0 },
    bowling: { pace: 0, spin: 0 },
    playersByRole: {},
    playersByCategory: {},
  };

  rosterDocs.forEach((doc) => {
    const player = doc.playerId;
    if (!player) return;

    const category = player.type;
    if (breakdown.categories.hasOwnProperty(category)) {
      breakdown.categories[category] += 1;
    }
    if (!breakdown.playersByCategory[category]) {
      breakdown.playersByCategory[category] = [];
    }
    breakdown.playersByCategory[category].push({
      userPlayerId: doc._id,
      playerId: player._id,
      name: player.name,
      role: player.role,
      type: player.type,
    });

    const role = player.role;
    if (breakdown.roles.hasOwnProperty(role)) {
      breakdown.roles[role] += 1;
      if (!breakdown.playersByRole[role]) breakdown.playersByRole[role] = [];
      breakdown.playersByRole[role].push({
        userPlayerId: doc._id,
        playerId: player._id,
        name: player.name,
        role: player.role,
        type: player.type,
      });
    }

    const battingHand = detectBattingHand(player);
    if (battingHand) breakdown.styles[battingHand] += 1;

    const bowlType = detectBowlingType(player);
    if (bowlType) breakdown.bowling[bowlType] += 1;
  });

  return breakdown;
};

const summarizeGaps = (counts, targets) => {
  const gaps = [];
  const surpluses = [];

  Object.entries(targets).forEach(([key, target]) => {
    const actual = counts[key] || 0;
    if (actual < target) {
      gaps.push({
        key,
        needed: target - actual,
        message: `Needs ${target - actual} more ${key}${target - actual > 1 ? 's' : ''}.`,
      });
    } else if (actual > target) {
      surpluses.push({
        key,
        available: actual - target,
      });
    }
  });

  return { gaps, surpluses };
};

const buildSummaryText = (teamName, balanceScore, gaps, strengths) => {
  if (!gaps.length && !strengths.length) {
    return `${teamName} has a steady squad.`;
  }

  const topGap = gaps[0]?.message || 'No critical gaps.';
  const strengthText = strengths.length
    ? `${teamName} excels with ${strengths.join(', ')}.`
    : `${teamName} is looking for tactical improvements.`;

  if (balanceScore >= 70) {
    return `${teamName} is well rounded. ${strengthText}`;
  }

  return `${teamName} needs attention: ${topGap} ${strengthText}`;
};

const analyzeTeamBalance = async (userId, options = {}) => {
  const includeRosterDocs = options.includeRoster === true;
  const user = await User.findById(userId).select('teamName isActive isAdmin');
  if (!user) {
    const err = new Error('Team not found');
    err.statusCode = 404;
    throw err;
  }

  const rosterDocs = await getActiveRoster(userId);
  const breakdown = computeBreakdown(rosterDocs);

  const deficits = [];
  const notes = [];
  const strengths = [];

  const batsmenCount = breakdown.roles.Batsman || 0;
  const bowlersCount = breakdown.roles.Bowler || 0;
  const allrounders = breakdown.roles.Allrounder || 0;
  const keepersCount = breakdown.roles.WicketKeeper || 0;
  const silverCount = breakdown.categories.Silver || 0;
  const sapphireCount = breakdown.categories.Sapphire || 0;
  const emeraldCount = breakdown.categories.Emerald || 0;

  const effectiveBats = batsmenCount + Math.floor(allrounders / 2);
  const effectiveBowls = bowlersCount + Math.ceil(allrounders / 2);

  const addDeficit = (entry) => deficits.push(entry);

  if (effectiveBats < ROLE_TARGETS.Batsman) {
    addDeficit({
      type: 'role',
      key: 'Batsman',
      needed: Math.max(ROLE_TARGETS.Batsman - batsmenCount, 1),
      message: 'Need at least 3 specialist batsmen for the XI.',
    });
  } else {
    strengths.push('Top-order depth');
  }

  if (effectiveBowls < ROLE_TARGETS.Bowler) {
    addDeficit({
      type: 'role',
      key: 'Bowler',
      needed: Math.max(ROLE_TARGETS.Bowler - bowlersCount, 1),
      message: 'Need 3 strike bowlers to satisfy XI rules.',
    });
  } else {
    strengths.push('Bowling options');
  }

  if (keepersCount < ROLE_TARGETS.WicketKeeper) {
    addDeficit({
      type: 'role',
      key: 'WicketKeeper',
      needed: 1,
      message: 'XI requires at least one wicketkeeper.',
    });
  } else {
    strengths.push('Wicketkeeping covered');
  }

  if (silverCount < MIN_SILVER_IN_XI) {
    addDeficit({
      type: 'category',
      key: 'Silver',
      needed: MIN_SILVER_IN_XI - silverCount,
      message: 'Need three Silver players in the XI.',
    });
  } else {
    strengths.push('Silver bench');
  }

  if (breakdown.totalPlayers < PLAYING_XI_SIZE) {
    notes.push(`Need ${PLAYING_XI_SIZE - breakdown.totalPlayers} more players to field an XI.`);
  }

  if (sapphireCount > MAX_SAPPHIRE_IN_XI) {
    notes.push('Only one Sapphire can play; consider trading surplus Sapphire talent.');
  }

  const emeraldLimit =
    sapphireCount > 0 ? MAX_EMERALD_WITH_SAPPHIRE : MAX_EMERALD_WITHOUT_SAPPHIRE;
  if (emeraldCount > emeraldLimit) {
    notes.push(
      `Emerald usage exceeds the cap (${emeraldLimit}) for your Sapphire combination.`
    );
  }

  const roleSurpluses = Object.entries(breakdown.roles)
    .filter(([role, count]) => count > (ROLE_TARGETS[role] || 0))
    .map(([role, count]) => ({
      role,
      available: count - (ROLE_TARGETS[role] || 0),
    }));

  const penaltyFromDeficits = deficits.reduce(
    (sum, def) => sum + def.needed * (def.type === 'role' ? 8 : 6),
    0
  );
  const clampedScore = clampScore(80 - penaltyFromDeficits - notes.length * 4);

  const summary = buildSummaryText(user.teamName || 'Team', clampedScore, deficits, strengths);

  const response = {
    userId,
    teamName: user.teamName || 'Team',
    totalPlayers: breakdown.totalPlayers,
    balanceScore: clampedScore,
    roles: breakdown.roles,
    categories: breakdown.categories,
    styles: breakdown.styles,
    bowling: breakdown.bowling,
    strengths,
    gaps: deficits.map((gap) => gap.message),
    recommendations: notes.slice(0, 3),
    summary,
    deficits: deficits.map((gap) => ({
      type: gap.type,
      key: gap.key,
      role: gap.type === 'role' ? gap.key : null,
      category: gap.type === 'category' ? gap.key : null,
      needed: gap.needed,
    })),
    surpluses: roleSurpluses,
  };

  if (includeRosterDocs) {
    response.__rosterDocs = rosterDocs;
    response.__playersByRole = breakdown.playersByRole;
    response.__playersByCategory = breakdown.playersByCategory;
  }

  return response;
};

const generateTradeRecommendations = async (userId, options = {}) => {
  const limit = options.limit || 3;
  const analysis =
    options.analysis ||
    (await analyzeTeamBalance(userId, { includeRoster: true }));
  const deficits = analysis.deficits || [];
  const surpluses = analysis.surpluses || [];
  const playersByRole = analysis.__playersByRole || {};
  const playersByCategory = analysis.__playersByCategory || {};
  const roles = analysis.roles || {};
  const categories = analysis.categories || {};

  const surplusRoles = surpluses
    .map((item) => ({
      role: item.role,
      available: item.available,
      players: [...(playersByRole[item.role] || [])],
    }))
    .filter((entry) => entry.available > 0 && entry.players.length);

  // Add category surplus when 2+ Sapphire (only 1 can play) - for optimization swaps
  if (categories.Sapphire > 1 && (playersByCategory.Sapphire || []).length > 0) {
    surplusRoles.push({
      role: 'Sapphire',
      available: categories.Sapphire - 1,
      players: [...(playersByCategory.Sapphire || [])].slice(0, categories.Sapphire - 1),
    });
  }

  if (!surplusRoles.length) {
    return [];
  }

  const otherTeams = await User.find({
    _id: { $ne: userId },
    isActive: true,
    isAdmin: { $ne: true },
  })
    .select('_id teamName')
    .lean();

  if (!otherTeams.length) {
    return [];
  }

  const otherTeamIds = otherTeams.map((team) => team._id);

  const otherRosters = await UserPlayer.find({
    userId: { $in: otherTeamIds },
    isActive: true,
  })
    .populate('playerId', 'name role type style battingStyle')
    .populate('userId', 'teamName')
    .lean();

  const rosterByTeam = {};
  otherRosters.forEach((doc) => {
    const user = doc.userId;
    if (!user || !doc.playerId) return;
    const userKey = String(user._id);
    if (!rosterByTeam[userKey]) {
      rosterByTeam[userKey] = {
        teamName: user.teamName || 'Team',
        players: [],
        roleCounts: {},
        categoryCounts: {},
      };
    }
    rosterByTeam[userKey].players.push(doc.playerId);
    const role = doc.playerId.role;
    if (role) {
      rosterByTeam[userKey].roleCounts[role] =
        (rosterByTeam[userKey].roleCounts[role] || 0) + 1;
    }
    const cat = doc.playerId.type;
    if (cat) {
      rosterByTeam[userKey].categoryCounts[cat] =
        (rosterByTeam[userKey].categoryCounts[cat] || 0) + 1;
    }
  });

  const recommended = [];

  // When balanced (no deficits), suggest depth swaps: offer surplus role, acquire depth in another
  const optimizationDeficits = [];
  if (!deficits.length && surplusRoles.length > 0) {
    const ROLE_ORDER = ['Batsman', 'Bowler', 'WicketKeeper', 'Allrounder'];
    for (const role of ROLE_ORDER) {
      const count = roles[role] || 0;
      const target = ROLE_TARGETS[role] || 0;
      if (count === target && target > 0) {
        optimizationDeficits.push({
          type: 'role',
          key: role,
          role,
          needed: 1,
          message: `Add ${role} depth`,
        });
      }
    }
    if (categories.Sapphire > 1 && (categories.Silver || 0) >= MIN_SILVER_IN_XI) {
      optimizationDeficits.push({
        type: 'category',
        key: 'Silver',
        role: null,
        needed: 1,
        message: 'Trade surplus Sapphire for extra Silver flexibility',
      });
    }
  }

  const deficitsToUse = deficits.length > 0 ? deficits : optimizationDeficits;

  for (const deficit of deficitsToUse) {
    if (recommended.length >= limit) break;

    const surplus = surplusRoles.find((entry) => entry.available > 0);
    if (!surplus) break;

    const candidateTeamEntry = Object.entries(rosterByTeam).find(([, data]) => {
      if (deficit.type === 'role') {
        return (data.roleCounts[deficit.role] || 0) > (ROLE_TARGETS[deficit.role] || 0);
      }
      if (deficit.type === 'category') {
        const baseline = deficit.key === 'Silver' ? MIN_SILVER_IN_XI : 0;
        return (data.categoryCounts[deficit.key] || 0) > baseline;
      }
      return false;
    });

    if (!candidateTeamEntry) {
      continue;
    }

    const [candidateTeamId, teamData] = candidateTeamEntry;
    const candidatePlayer = teamData.players.find((p) =>
      deficit.type === 'role' ? p.role === deficit.role : p.type === deficit.key
    );
    if (!candidatePlayer) {
      continue;
    }

    const offerPlayer = surplus.players.shift();
    if (!offerPlayer) continue;
    surplus.available -= 1;

    recommended.push({
      focus: deficit.message || (deficit.type === 'role' ? `Need ${deficit.role}` : `Need ${deficit.key} presence`),
      acquire: {
        playerId: candidatePlayer._id,
        name: candidatePlayer.name,
        role: candidatePlayer.role,
        type: candidatePlayer.type,
        fromTeam: teamData.teamName,
      },
      offer: offerPlayer
        ? {
            playerId: offerPlayer.playerId,
            name: offerPlayer.name,
            role: offerPlayer.role,
            type: offerPlayer.type,
          }
        : null,
      rationale:
        deficit.type === 'role'
          ? `Adds ${deficit.role} depth from ${teamData.teamName} while moving surplus ${surplus.role}.`
          : surplus.role === 'Sapphire'
            ? `Trade surplus Sapphire for extra Silver flexibility from ${teamData.teamName}.`
            : `Secures a ${deficit.key} pick from ${teamData.teamName} to meet XI requirements.`,
    });

    // Ensure we don't reuse same team repeatedly by reducing their surplus count
    if (deficit.type === 'role') {
      teamData.roleCounts[deficit.role] -= 1;
    } else if (deficit.type === 'category') {
      teamData.categoryCounts[deficit.key] -= 1;
    }
  }

  return recommended.slice(0, limit);
};

module.exports = {
  ROLE_TARGETS,
  CATEGORY_TARGETS,
  analyzeTeamBalance,
  generateTradeRecommendations,
};

