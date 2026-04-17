/**
 * Live updates to User.careerMatchesPlayed / careerWins when a match completes:
 * league fixture save, playoff update, tournament (World Cup) fixture update.
 * Historical totals from old DBs are loaded only via scripts/syncTeamCareerFromAllDbs.js (not the HTTP API).
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

module.exports = {
  applyCareerLeagueResult,
  isPlaceholderTeamName,
};
