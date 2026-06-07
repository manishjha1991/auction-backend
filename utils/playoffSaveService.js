/**
 * Single source of truth for playoff fixture result persistence.
 * Used by POST /api/playoff-fixtures/update and playoff submission approval.
 */
const PlayoffFixture = require('../models/PlayoffFixture');
const User = require('../models/User');
const headToHeadModule = require('../routes/headToHead');
const { applyCareerLeagueResult } = require('./careerUserCounters');

const normalizeTeamKey = (value = '') =>
  String(value || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

const isPlaceholderTeam = (name = '') =>
  String(name).includes('Winner of') || String(name).includes('Loser of');

async function getUserIdFromTeamName(teamName) {
  if (!teamName || isPlaceholderTeam(teamName)) return null;
  const user = await User.findOne({ teamName, isActive: true });
  return user?._id || null;
}

function resolvePlayoffWinnerUserId(winner, fixture) {
  if (!winner || !fixture) return null;

  const winnerStr = String(winner).trim();
  if (fixture.team1UserId && winnerStr === String(fixture.team1UserId)) return fixture.team1UserId;
  if (fixture.team2UserId && winnerStr === String(fixture.team2UserId)) return fixture.team2UserId;

  const wKey = normalizeTeamKey(winnerStr);
  if (!wKey) return null;

  if (fixture.team1UserId && wKey === normalizeTeamKey(fixture.team1)) return fixture.team1UserId;
  if (fixture.team2UserId && wKey === normalizeTeamKey(fixture.team2)) return fixture.team2UserId;

  return null;
}

function resolvePlayoffWinnerName(winner, fixture) {
  if (!winner || !fixture) return winner;

  const winnerUserId = resolvePlayoffWinnerUserId(winner, fixture);
  if (winnerUserId && fixture.team1UserId && String(winnerUserId) === String(fixture.team1UserId)) {
    return fixture.team1;
  }
  if (winnerUserId && fixture.team2UserId && String(winnerUserId) === String(fixture.team2UserId)) {
    return fixture.team2;
  }

  const wKey = normalizeTeamKey(winner);
  if (wKey && wKey === normalizeTeamKey(fixture.team1)) return fixture.team1;
  if (wKey && wKey === normalizeTeamKey(fixture.team2)) return fixture.team2;
  return winner;
}

function isPlayoffMatchReady(fixture) {
  if (!fixture) return false;
  if (fixture.winner) return false;
  return !isPlaceholderTeam(fixture.team1) && !isPlaceholderTeam(fixture.team2);
}

function userInPlayoffFixture(user, fixture) {
  if (!user || !fixture) return false;
  const uid = String(user._id);
  if (fixture.team1UserId && String(fixture.team1UserId) === uid) return true;
  if (fixture.team2UserId && String(fixture.team2UserId) === uid) return true;
  const team = user.teamName || '';
  if (!team) return false;
  const mine = normalizeTeamKey(team);
  return (
    mine === normalizeTeamKey(fixture.team1 || '') ||
    mine === normalizeTeamKey(fixture.team2 || '')
  );
}

async function updateDependentMatches(matchId, winner) {
  try {
    const winnerUserId = await getUserIdFromTeamName(winner);

    let isGroupsMode = ['Q1', 'Q2', 'SF1', 'SF2'].includes(matchId);

    if (matchId === 'F') {
      const finalMatch = await PlayoffFixture.findOne({ matchId: 'F' });
      isGroupsMode = finalMatch && finalMatch.stage === 'FINAL';
    }

    if (isGroupsMode) {
      switch (matchId) {
        case 'Q1':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'SF1' },
            { team2: winner, team2UserId: winnerUserId },
            { new: true }
          );
          break;
        case 'Q2':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'SF2' },
            { team2: winner, team2UserId: winnerUserId },
            { new: true }
          );
          break;
        case 'SF1':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team1: winner, team1UserId: winnerUserId }
          );
          break;
        case 'SF2':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team2: winner, team2UserId: winnerUserId }
          );
          break;
        default:
          break;
      }
    } else {
      switch (matchId) {
        case 'A':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'D' },
            { team1: winner, team1UserId: winnerUserId }
          );
          break;
        case 'B':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'D' },
            { team2: winner, team2UserId: winnerUserId }
          );
          break;
        case 'C': {
          const matchC = await PlayoffFixture.findOne({ matchId: 'C' });
          const loser = matchC.team1 === winner ? matchC.team2 : matchC.team1;
          const loserUserId = await getUserIdFromTeamName(loser);
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'E' },
            { team1: loser, team1UserId: loserUserId }
          );
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team1: winner, team1UserId: winnerUserId }
          );
          break;
        }
        case 'D':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'E' },
            { team2: winner, team2UserId: winnerUserId }
          );
          break;
        case 'E':
          await PlayoffFixture.findOneAndUpdate(
            { matchId: 'F' },
            { team2: winner, team2UserId: winnerUserId }
          );
          break;
        default:
          break;
      }
    }
  } catch (error) {
    console.error('Error updating dependent matches:', error);
    throw error;
  }
}

/**
 * Apply playoff result — same path as admin POST /api/playoff-fixtures/update/:matchId
 */
async function applyPlayoffFixtureResult(matchId, body = {}) {
  const existing = await PlayoffFixture.findOne({ matchId }).lean();
  if (!existing) return null;

  const updateData = { ...body };

  if (updateData.winner && !updateData.winnerUserId) {
    const winnerUser = await User.findOne({ teamName: updateData.winner, isActive: true }).lean();
    if (winnerUser) updateData.winnerUserId = winnerUser._id;
  }

  if (
    updateData.team1 &&
    !updateData.team1UserId &&
    !isPlaceholderTeam(updateData.team1)
  ) {
    const team1User = await User.findOne({ teamName: updateData.team1, isActive: true }).lean();
    if (team1User) updateData.team1UserId = team1User._id;
  }

  if (
    updateData.team2 &&
    !updateData.team2UserId &&
    !isPlaceholderTeam(updateData.team2)
  ) {
    const team2User = await User.findOne({ teamName: updateData.team2, isActive: true }).lean();
    if (team2User) updateData.team2UserId = team2User._id;
  }

  const playoffFixture = await PlayoffFixture.findOneAndUpdate({ matchId }, updateData, {
    new: true,
  });

  if (updateData.winner && updateData.isCompleted) {
    await updateDependentMatches(matchId, updateData.winner);

    const t1 = playoffFixture.team1;
    const t2 = playoffFixture.team2;
    const newWinner = playoffFixture.winner;
    const validTeams =
      t1 &&
      t2 &&
      !isPlaceholderTeam(t1) &&
      !isPlaceholderTeam(t2);

    if (validTeams && newWinner) {
      const oldWinner = existing?.winner || null;
      const oldT1 = existing?.team1;
      const oldT2 = existing?.team2;
      const oldValid =
        oldT1 &&
        oldT2 &&
        !isPlaceholderTeam(oldT1) &&
        !isPlaceholderTeam(oldT2);

      await PlayoffFixture.updateOne({ matchId }, { $set: { headToHeadSynced: false } });

      if (oldWinner && oldWinner !== newWinner && oldValid && headToHeadModule.revertAndResyncForRecord) {
        headToHeadModule
          .revertAndResyncForRecord(oldT1, oldT2, oldWinner)
          .catch((err) => console.error('Head-to-head sync:', err));
      } else if (headToHeadModule.syncHeadToHead) {
        headToHeadModule.syncHeadToHead().catch((err) => console.error('Head-to-head sync:', err));
      }

      const shouldBumpCareer = validTeams && newWinner && (!oldWinner || oldWinner !== newWinner);
      if (shouldBumpCareer) {
        applyCareerLeagueResult({
          team1: playoffFixture.team1,
          team2: playoffFixture.team2,
          newWinnerName: newWinner,
          oldWinnerName: oldWinner || null,
        }).catch((err) => console.error('Career counters (playoff):', err));
      }
    }
  }

  return playoffFixture;
}

function buildPlayoffUpdateFromSubmission(submission) {
  return {
    winner: submission.winner,
    margin: submission.margin,
    team1Score: submission.team1Score,
    team2Score: submission.team2Score,
    mom: {
      name: submission.mom?.name || null,
      score: submission.mom?.score != null ? Number(submission.mom.score) : 0,
      wickets: submission.mom?.wickets != null ? Number(submission.mom.wickets) : 0,
    },
    team1Fairness: Number(submission.team1Fairness) || 0,
    team2Fairness: Number(submission.team2Fairness) || 0,
    isCompleted: !!submission.winner,
  };
}

module.exports = {
  normalizeTeamKey,
  isPlaceholderTeam,
  isPlayoffMatchReady,
  userInPlayoffFixture,
  resolvePlayoffWinnerUserId,
  resolvePlayoffWinnerName,
  applyPlayoffFixtureResult,
  buildPlayoffUpdateFromSubmission,
};
