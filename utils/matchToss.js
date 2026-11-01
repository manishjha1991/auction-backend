const crypto = require('crypto');

function isPlaceholderTeam(name) {
  const n = String(name || '').trim();
  if (!n || n.length < 2) return true;
  return /^(tbd|tba|na|n\/a|winner|loser|waiting)/i.test(n)
    || /winner of|loser of|qualifier|eliminator|to be decided|^top \d+$/i.test(n);
}

function idStr(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value._id || value.id || '');
  return String(value);
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTossWinner(team1, team2, team1UserId, team2UserId) {
  const chooseSecond = crypto.randomInt(0, 2) === 1;
  if (chooseSecond) {
    return { tossWinner: team2, tossWinnerUserId: team2UserId || null };
  }
  return { tossWinner: team1, tossWinnerUserId: team1UserId || null };
}

function namesMatch(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  return Boolean(left) && left === right;
}

function isMatchPlayed(fixture) {
  if (!fixture) return true;
  if (fixture.winner) return true;
  if (fixture.isCompleted === true) return true;
  const t1 = String(fixture.team1Score || '').trim();
  const t2 = String(fixture.team2Score || '').trim();
  const scored = t1 && t2 && t1 !== 'TBD' && t2 !== 'TBD' && t1 !== '—' && t2 !== '—';
  return Boolean(scored);
}

function canUserToss({ user, team1, team2, team1UserId, team2UserId }) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const uid = idStr(user._id || user.id);
  if (uid && (idStr(team1UserId) === uid || idStr(team2UserId) === uid)) return true;
  const teamName = user.teamName;
  const abbr = user.abbreviation;
  return namesMatch(teamName, team1)
    || namesMatch(teamName, team2)
    || namesMatch(abbr, team1)
    || namesMatch(abbr, team2);
}

function assertCanToss({ fixture, user, alreadyWinnerField = 'winner' }) {
  if (!fixture) {
    const err = new Error('Match not found');
    err.status = 404;
    throw err;
  }
  if (fixture[alreadyWinnerField] || isMatchPlayed(fixture)) {
    const err = new Error('Toss is only for unplayed matches');
    err.status = 400;
    throw err;
  }
  if (isPlaceholderTeam(fixture.team1) || isPlaceholderTeam(fixture.team2)) {
    const err = new Error('Both teams must be set before the toss');
    err.status = 400;
    throw err;
  }
  if (fixture.tossWinner) {
    const err = new Error(`${fixture.tossWinner} already won the toss. Toss cannot be reversed.`);
    err.status = 409;
    err.payload = {
      tossWinner: fixture.tossWinner,
      tossWinnerUserId: fixture.tossWinnerUserId || null,
      tossAt: fixture.tossAt || null,
    };
    throw err;
  }
  if (!canUserToss({
    user,
    team1: fixture.team1,
    team2: fixture.team2,
    team1UserId: fixture.team1UserId,
    team2UserId: fixture.team2UserId,
  })) {
    const err = new Error('Only the two playing teams or an admin can toss');
    err.status = 403;
    throw err;
  }
}

module.exports = {
  isPlaceholderTeam,
  pickTossWinner,
  canUserToss,
  assertCanToss,
  isMatchPlayed,
  idStr,
};
