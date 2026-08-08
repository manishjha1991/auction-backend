/**
 * World Cup / tournament fixture helpers.
 * Used by playoff-fixtures GET (WC mode), playoff submissions, and tournament PUT.
 */
const Tournament = require('../models/Tournament');
const { applyCareerLeagueResult } = require('./careerUserCounters');

const expectedRoundRobinFixtureCount = (tournament) => {
  const n = tournament?.subscribedTeams?.length || 0;
  return n >= 2 ? (n * (n - 1)) / 2 : 0;
};

const normalizeTeamKey = (value = '') =>
  String(value || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

const isPlaceholderTeam = (name = '') => {
  const s = String(name || '');
  return s.includes('Winner of') || s.includes('Loser of') || s.includes('Top ');
};

async function findRunningWorldCupTournament() {
  // Prefer explicit World Cup–named running tournaments.
  // Names vary: "World Cup 3", "World Cup Session 3", "World Cup Season 1", "T20 World Cup".
  const wcNamed = await Tournament.find({
    status: 'running',
    name: { $regex: /world\s*cup|\bwc\b/i },
  })
    .sort({ startDate: -1, createdAt: -1 })
    .limit(1);

  if (wcNamed[0]) return wcNamed[0];

  // Fallback while WC mode is on: any running tournament with fixtures.
  const anyRunning = await Tournament.find({
    status: 'running',
    'tournamentFixtures.0': { $exists: true },
  })
    .sort({ startDate: -1, createdAt: -1 })
    .limit(1);

  return anyRunning[0] || null;
}

function describeFixtureStage(tournament, fixtureIndex, fixture) {
  const rrCount = expectedRoundRobinFixtureCount(tournament);
  const fx = fixture || tournament?.tournamentFixtures?.[fixtureIndex];

  if (rrCount > 0 && fixtureIndex >= rrCount) {
    const knockoutOffset = fixtureIndex - rrCount;
    if (knockoutOffset === 0) {
      return { stage: 'WORLD CUP SEMI-FINAL 1', matchId: 'WCSF1', wcStage: 'semi' };
    }
    if (knockoutOffset === 1) {
      return { stage: 'WORLD CUP SEMI-FINAL 2', matchId: 'WCSF2', wcStage: 'semi' };
    }
    return { stage: 'WORLD CUP FINAL', matchId: 'WCF', wcStage: 'final' };
  }

  // Legacy placeholder detection when RR count is unknown / mismatched
  if (fx?.team1?.includes('Winner of') || fx?.team2?.includes('Winner of')) {
    return { stage: 'WORLD CUP FINAL', matchId: 'WCF', wcStage: 'final' };
  }
  if (fx?.team1?.includes('Top 1') || fx?.team1?.includes('Top 4')) {
    return { stage: 'WORLD CUP SEMI-FINAL 1', matchId: 'WCSF1', wcStage: 'semi' };
  }
  if (fx?.team1?.includes('Top 2') || fx?.team1?.includes('Top 3')) {
    return { stage: 'WORLD CUP SEMI-FINAL 2', matchId: 'WCSF2', wcStage: 'semi' };
  }

  return {
    stage: 'WORLD CUP ROUND-ROBIN',
    matchId: `WC${fixtureIndex + 1}`,
    wcStage: 'super8',
  };
}

function mapTournamentFixturesToPlayoffShape(tournament) {
  if (!tournament?.tournamentFixtures?.length) return [];

  return tournament.tournamentFixtures.map((fixture, index) => {
    const meta = describeFixtureStage(tournament, index, fixture);
    return {
      _id: fixture._id || `wc-${tournament._id}-${index}`,
      matchId: meta.matchId,
      stage: meta.stage,
      wcStage: meta.wcStage,
      team1: fixture.team1,
      team2: fixture.team2,
      team1UserId: fixture.team1UserId,
      team2UserId: fixture.team2UserId,
      team1Score: fixture.team1Score || 'TBD',
      team2Score: fixture.team2Score || 'TBD',
      team1Overs: fixture.team1Overs || null,
      team2Overs: fixture.team2Overs || null,
      winner: fixture.winner || null,
      winnerUserId: fixture.winnerUserId || null,
      margin: fixture.margin || null,
      mom: fixture.mom || { name: null, score: null, wickets: null },
      team1Fairness: fixture.team1Fairness || 0,
      team2Fairness: fixture.team2Fairness || 0,
      description: `${fixture.team1} vs ${fixture.team2}`,
      createdAt: fixture.createdAt || new Date(),
      tournamentId: String(tournament._id),
      fixtureIndex: index,
      isWorldCupTournament: true,
      tournamentName: tournament.name || '',
    };
  });
}

function resolveTournamentFixtureByMatchId(tournament, matchId) {
  if (!tournament?.tournamentFixtures?.length || !matchId) return null;
  const mapped = mapTournamentFixturesToPlayoffShape(tournament);
  const hit = mapped.find((fx) => String(fx.matchId) === String(matchId));
  if (!hit) return null;
  return {
    virtual: hit,
    fixture: tournament.tournamentFixtures[hit.fixtureIndex],
    fixtureIndex: hit.fixtureIndex,
  };
}

function resolveWinnerOnTournamentFixture(winner, fixture) {
  if (!winner || !fixture) return { winnerName: null, winnerUserId: null };

  const winnerStr = String(winner).trim();
  if (fixture.team1UserId && winnerStr === String(fixture.team1UserId)) {
    return { winnerName: fixture.team1, winnerUserId: fixture.team1UserId };
  }
  if (fixture.team2UserId && winnerStr === String(fixture.team2UserId)) {
    return { winnerName: fixture.team2, winnerUserId: fixture.team2UserId };
  }

  const wKey = normalizeTeamKey(winnerStr);
  if (wKey && wKey === normalizeTeamKey(fixture.team1)) {
    return { winnerName: fixture.team1, winnerUserId: fixture.team1UserId || null };
  }
  if (wKey && wKey === normalizeTeamKey(fixture.team2)) {
    return { winnerName: fixture.team2, winnerUserId: fixture.team2UserId || null };
  }

  return { winnerName: null, winnerUserId: null };
}

/**
 * Apply a match result onto Tournament.tournamentFixtures[fixtureIndex].
 * Mirrors admin PUT /tournaments/:id/fixtures/:fixtureIndex side effects.
 */
async function applyTournamentFixtureResult(tournamentId, fixtureIndex, body = {}) {
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) {
    const err = new Error('Tournament not found');
    err.status = 404;
    throw err;
  }

  const idx = Number(fixtureIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= tournament.tournamentFixtures.length) {
    const err = new Error('Fixture not found');
    err.status = 404;
    throw err;
  }

  const {
    winner,
    margin,
    team1Score,
    team2Score,
    team1Overs,
    team2Overs,
    team1Fairness,
    team2Fairness,
    mom,
  } = body;

  const scoreFormatRegex = /^\d+\/\d+$/;
  if (team1Score && !scoreFormatRegex.test(String(team1Score).trim())) {
    const err = new Error(
      `Team 1 score format is invalid. Expected runs/wickets. Received: "${team1Score}"`
    );
    err.status = 400;
    throw err;
  }
  if (team2Score && !scoreFormatRegex.test(String(team2Score).trim())) {
    const err = new Error(
      `Team 2 score format is invalid. Expected runs/wickets. Received: "${team2Score}"`
    );
    err.status = 400;
    throw err;
  }
  if (!team1Overs || String(team1Overs).trim() === '') {
    const err = new Error('Team 1 overs is required');
    err.status = 400;
    throw err;
  }
  if (!team2Overs || String(team2Overs).trim() === '') {
    const err = new Error('Team 2 overs is required');
    err.status = 400;
    throw err;
  }

  const oldWinner = tournament.tournamentFixtures[idx].winner || null;
  const resolved = resolveWinnerOnTournamentFixture(winner, tournament.tournamentFixtures[idx]);
  const winnerName = resolved.winnerName || winner || null;

  if (winner !== undefined) {
    tournament.tournamentFixtures[idx].winner = winnerName;
    tournament.tournamentFixtures[idx].winnerUserId = resolved.winnerUserId || null;
  }
  if (margin !== undefined) tournament.tournamentFixtures[idx].margin = margin;
  if (team1Score !== undefined) tournament.tournamentFixtures[idx].team1Score = team1Score;
  if (team2Score !== undefined) tournament.tournamentFixtures[idx].team2Score = team2Score;
  tournament.tournamentFixtures[idx].team1Overs = String(team1Overs).trim();
  tournament.tournamentFixtures[idx].team2Overs = String(team2Overs).trim();
  if (team1Fairness !== undefined) {
    tournament.tournamentFixtures[idx].team1Fairness = team1Fairness;
  }
  if (team2Fairness !== undefined) {
    tournament.tournamentFixtures[idx].team2Fairness = team2Fairness;
  }
  if (mom !== undefined) {
    tournament.tournamentFixtures[idx].mom = {
      name: mom.name || null,
      score: mom.score !== undefined ? mom.score : null,
      wickets: mom.wickets !== undefined ? mom.wickets : null,
    };
  }

  const currentFixture = tournament.tournamentFixtures[idx];
  const roundRobinCount = expectedRoundRobinFixtureCount(tournament);
  const hasPlaceholder =
    currentFixture.team1?.includes('Winner of') ||
    currentFixture.team1?.includes('Top ') ||
    currentFixture.team2?.includes('Winner of') ||
    currentFixture.team2?.includes('Top ');
  const isAfterRoundRobin = idx >= roundRobinCount;
  const isKnockoutFixture = hasPlaceholder || isAfterRoundRobin;

  await tournament.save();

  const fxAfterSave = tournament.tournamentFixtures[idx];
  const twNow = fxAfterSave.winner;
  if (twNow && (!oldWinner || oldWinner !== twNow)) {
    applyCareerLeagueResult({
      team1: fxAfterSave.team1,
      team2: fxAfterSave.team2,
      newWinnerName: twNow,
      oldWinnerName: oldWinner || null,
    }).catch((err) => console.error('Career counters (tournament OCR):', err));
  }

  if (
    !isKnockoutFixture &&
    (winner || team1Score !== undefined || team2Score !== undefined)
  ) {
    const { updateTournamentPointTable } = require('../routes/tournaments');
    await updateTournamentPointTable(tournament._id);
  }

  if (
    isKnockoutFixture &&
    (winner || team1Score !== undefined || team2Score !== undefined)
  ) {
    const isLastFixture = idx === tournament.tournamentFixtures.length - 1;
    const isActualFinalPlaceholder =
      (currentFixture.team1 === 'Winner of Semi-Final 1' &&
        currentFixture.team2 === 'Winner of Semi-Final 2') ||
      (currentFixture.team1 === 'Winner of Semi-Final 2' &&
        currentFixture.team2 === 'Winner of Semi-Final 1');
    const knockoutFixtures = tournament.tournamentFixtures.slice(roundRobinCount);
    const isLastKnockout =
      idx >= roundRobinCount && idx - roundRobinCount === knockoutFixtures.length - 1;
    const isFinalMatch =
      (isLastFixture && !!winnerName) ||
      (isActualFinalPlaceholder && !!winnerName) ||
      (isLastKnockout && !!winnerName);

    if (isFinalMatch && winnerName) {
      const completionDate = new Date();
      const winnerTeam = tournament.subscribedTeams.find((t) => t.teamName === winnerName);
      tournament.winner = {
        teamName: winnerName,
        teamImage: winnerTeam?.teamImage || null,
        wonAt: completionDate,
      };
      tournament.status = 'completed';
      tournament.endDate = completionDate;
      await tournament.save();
    }

    if (isKnockoutFixture && winnerName && !isFinalMatch) {
      let updatedTournament = await Tournament.findById(tournamentId);
      if (updatedTournament) {
        const finalIndex = updatedTournament.tournamentFixtures.findIndex(
          (f) =>
            (f.team1 === 'Winner of Semi-Final 1' && f.team2 === 'Winner of Semi-Final 2') ||
            (f.team1 === 'Winner of Semi-Final 2' && f.team2 === 'Winner of Semi-Final 1')
        );

        if (finalIndex !== -1) {
          const semiFinal1Index = finalIndex - 2;
          const semiFinal2Index = finalIndex - 1;
          if (semiFinal1Index >= 0 && semiFinal2Index >= 0) {
            const semiFinal1 = updatedTournament.tournamentFixtures[semiFinal1Index];
            const semiFinal2 = updatedTournament.tournamentFixtures[semiFinal2Index];
            const finalFixture = updatedTournament.tournamentFixtures[finalIndex];

            const getUserIdFromTeamName = (teamName) => {
              const want = teamName ? String(teamName).trim() : '';
              const subscribedTeam = updatedTournament.subscribedTeams.find(
                (team) => String(team.teamName || '').trim() === want
              );
              return subscribedTeam?.userId || null;
            };

            let changed = false;
            if (semiFinal1.winner) {
              if (finalFixture.team1 === 'Winner of Semi-Final 1') {
                finalFixture.team1 = semiFinal1.winner;
                finalFixture.team1UserId = getUserIdFromTeamName(semiFinal1.winner);
                changed = true;
              } else if (finalFixture.team2 === 'Winner of Semi-Final 1') {
                finalFixture.team2 = semiFinal1.winner;
                finalFixture.team2UserId = getUserIdFromTeamName(semiFinal1.winner);
                changed = true;
              }
            }
            if (semiFinal2.winner) {
              if (finalFixture.team2 === 'Winner of Semi-Final 2') {
                finalFixture.team2 = semiFinal2.winner;
                finalFixture.team2UserId = getUserIdFromTeamName(semiFinal2.winner);
                changed = true;
              } else if (finalFixture.team1 === 'Winner of Semi-Final 2') {
                finalFixture.team1 = semiFinal2.winner;
                finalFixture.team1UserId = getUserIdFromTeamName(semiFinal2.winner);
                changed = true;
              }
            }
            if (changed) {
              await updatedTournament.save();
              return {
                tournament: updatedTournament,
                fixture: updatedTournament.tournamentFixtures[idx],
                fixtureIndex: idx,
              };
            }
          }
        }
      }
    }
  }

  const fresh = await Tournament.findById(tournamentId);
  return {
    tournament: fresh || tournament,
    fixture: (fresh || tournament).tournamentFixtures[idx],
    fixtureIndex: idx,
  };
}

module.exports = {
  expectedRoundRobinFixtureCount,
  isPlaceholderTeam,
  findRunningWorldCupTournament,
  describeFixtureStage,
  mapTournamentFixturesToPlayoffShape,
  resolveTournamentFixtureByMatchId,
  resolveWinnerOnTournamentFixture,
  applyTournamentFixtureResult,
};
