/**
 * Live updates to User.careerMatchesPlayed / careerWins when a match completes:
 * league fixture save, playoff update, tournament (World Cup) fixture update.
 * Historical totals from old DBs are seeded during ops (not the HTTP API).
 */

const User = require('../models/User');

const norm = (s) => String(s || '').trim().toLowerCase();

function isPlaceholderTeamName(name) {
  const s = String(name || '');
  return (
    s.includes('Winner of') ||
    s.includes('Loser of') ||
    s.includes('Top ')
  );
}

/**
 * Apply career counters for one completed match (league fixture, playoff, or tournament fixture).
 * - First result: both teams +1 played, winner +1 wins.
 * - Winner correction: −1 wins old winner, +1 wins new winner; played unchanged.
 * - Same winner re-save: no-op.
 *
 * @param {object} opts
 * @param {string} opts.team1
 * @param {string} opts.team2
 * @param {string} opts.newWinnerName - team name as stored on fixture (matches User.teamName)
 * @param {string|null|undefined} opts.oldWinnerName
 */
async function applyCareerLeagueResult({ team1, team2, newWinnerName, oldWinnerName }) {
  if (!team1 || !team2 || !newWinnerName) return;
  if (isPlaceholderTeamName(team1) || isPlaceholderTeamName(team2)) return;

  const nw = norm(newWinnerName);
  const t1 = norm(team1);
  const t2 = norm(team2);
  if (nw === 'tie' || nw === 'no_result' || nw === 'tbd') return;
  if (nw !== t1 && nw !== t2) return;

  const ow = oldWinnerName ? norm(oldWinnerName) : '';

  const incOpts = { includeInactive: true };

  if (ow && ow !== nw) {
    if (ow === t1 || ow === t2) {
      const oldName = ow === t1 ? team1 : team2;
      await User.findOneAndUpdate(
        { teamName: oldName },
        { $inc: { careerWins: -1 } },
        incOpts
      );
    }
    await User.findOneAndUpdate(
      { teamName: newWinnerName },
      { $inc: { careerWins: 1 } },
      incOpts
    );
    return;
  }

  if (ow === nw) return;

  await User.findOneAndUpdate({ teamName: team1 }, { $inc: { careerMatchesPlayed: 1 } }, incOpts);
  await User.findOneAndUpdate({ teamName: team2 }, { $inc: { careerMatchesPlayed: 1 } }, incOpts);
  await User.findOneAndUpdate({ teamName: newWinnerName }, { $inc: { careerWins: 1 } }, incOpts);
}

/**
 * Undo career bump when a completed league result is cleared (e.g. forfeit restore).
 * Both teams −1 played; winner −1 wins. Floors at 0.
 */
async function revertCareerLeagueResult({ team1, team2, winnerName }) {
  if (!team1 || !team2 || !winnerName) return;
  if (isPlaceholderTeamName(team1) || isPlaceholderTeamName(team2)) return;

  const nw = norm(winnerName);
  const t1 = norm(team1);
  const t2 = norm(team2);
  if (nw === 'tie' || nw === 'no_result' || nw === 'tbd') return;
  if (nw !== t1 && nw !== t2) return;

  const incOpts = { includeInactive: true };

  const decPlayed = async (teamName) => {
    const u = await User.findOne({ teamName }).setOptions(incOpts);
    if (!u) return;
    u.careerMatchesPlayed = Math.max(0, (u.careerMatchesPlayed || 0) - 1);
    await u.save();
  };

  await decPlayed(team1);
  await decPlayed(team2);

  const winner = await User.findOne({ teamName: winnerName }).setOptions(incOpts);
  if (winner) {
    winner.careerWins = Math.max(0, (winner.careerWins || 0) - 1);
    await winner.save();
  }
}

module.exports = {
  applyCareerLeagueResult,
  revertCareerLeagueResult,
  isPlaceholderTeamName,
};
