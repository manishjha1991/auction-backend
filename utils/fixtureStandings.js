/**
 * Live updates to User.points / matchesPlayed / fairnessPoint when a league fixture result is saved.
 * Mirrors career counter transitions: first result, winner correction, same-winner no-op, clear.
 */

const User = require('../models/User');

function sameTeamName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * Apply points-table deltas for one fixture save.
 * - First result: winner +2 points, both teams +1 matchesPlayed, fairness applied once.
 * - Winner correction: −2 old winner, +2 new winner; matches/fairness unchanged.
 * - Same winner re-save: no-op (prevents standings inflation when editing MOM/score).
 * - Cleared result: reverse winner points and matchesPlayed.
 *
 * @returns {Promise<{ applied: boolean, reason: string }>}
 */
async function applyFixtureStandingsTransition({
  team1,
  team2,
  newWinnerName,
  oldWinnerName,
  team1Fairness = 0,
  team2Fairness = 0,
}) {
  if (!team1 || !team2) return { applied: false, reason: 'missing_teams' };

  const hasNew = Boolean(newWinnerName);
  const hasOld = Boolean(oldWinnerName);

  if (!hasNew && !hasOld) return { applied: false, reason: 'no_result' };

  if (hasNew && hasOld && sameTeamName(oldWinnerName, newWinnerName)) {
    return { applied: false, reason: 'same_winner' };
  }

  if (hasOld && hasNew) {
    await User.findOneAndUpdate({ teamName: oldWinnerName }, { $inc: { points: -2 } });
    await User.findOneAndUpdate({ teamName: newWinnerName }, { $inc: { points: 2 } });
    return { applied: true, reason: 'winner_changed' };
  }

  if (hasOld && !hasNew) {
    await User.findOneAndUpdate({ teamName: oldWinnerName }, { $inc: { points: -2 } });
    await User.findOneAndUpdate({ teamName: team1 }, { $inc: { matchesPlayed: -1 } });
    await User.findOneAndUpdate({ teamName: team2 }, { $inc: { matchesPlayed: -1 } });
    return { applied: true, reason: 'result_cleared' };
  }

  // First result — preserve legacy award: exact team1 match wins, otherwise team2.
  const winnerTeam = newWinnerName === team1 ? team1 : team2;
  const t1Fair = Number(team1Fairness) || 0;
  const t2Fair = Number(team2Fairness) || 0;

  await User.findOneAndUpdate(
    { teamName: winnerTeam },
    { $inc: { points: 2 } }
  );
  await User.findOneAndUpdate(
    { teamName: team1 },
    { $inc: { matchesPlayed: 1, fairnessPoint: t1Fair } }
  );
  await User.findOneAndUpdate(
    { teamName: team2 },
    { $inc: { matchesPlayed: 1, fairnessPoint: t2Fair } }
  );

  return { applied: true, reason: 'first_result' };
}

module.exports = {
  applyFixtureStandingsTransition,
  sameTeamName,
};
