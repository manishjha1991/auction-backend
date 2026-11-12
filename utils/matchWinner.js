/**
 * Result identity is user IDs. Names are display-only and may change after a rename.
 * Name matching exists only to map a payload onto team1UserId / team2UserId.
 */

const normalizeTeamKey = (value = '') =>
  String(value || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

const idStr = (value) => {
  if (value == null || value === '') return '';
  if (typeof value === 'object') {
    if (value._id) return String(value._id);
    if (typeof value.toString === 'function' && value.toString() !== '[object Object]') {
      return String(value);
    }
    return '';
  }
  return String(value);
};

function idsEqual(a, b) {
  const x = idStr(a);
  const y = idStr(b);
  return Boolean(x && y && x === y);
}

function addAlias(list, name, userId) {
  const key = normalizeTeamKey(name);
  if (!key || !userId) return;
  list.push({ key, userId });
}

function resolveWinnerUserId(winner, fixture, aliases = {}) {
  if (winner == null || winner === '' || !fixture) return null;

  const team1Id = fixture.team1UserId;
  const team2Id = fixture.team2UserId;
  if (idsEqual(winner, team1Id)) return team1Id;
  if (idsEqual(winner, team2Id)) return team2Id;

  const wKey = normalizeTeamKey(winner);
  if (!wKey) return null;

  const aliasesFor = [];
  addAlias(aliasesFor, fixture.team1, team1Id);
  addAlias(aliasesFor, fixture.team2, team2Id);
  addAlias(aliasesFor, aliases.team1, team1Id);
  addAlias(aliasesFor, aliases.team2, team2Id);
  addAlias(aliasesFor, aliases.team1Abbreviation, team1Id);
  addAlias(aliasesFor, aliases.team2Abbreviation, team2Id);

  const hit = aliasesFor.find((row) => row.key === wKey);
  return hit ? hit.userId : null;
}

function pickWinnerUserId(winner, fixture, aliases = {}, winnerUserId) {
  if (winnerUserId) {
    const fromId = resolveWinnerUserId(winnerUserId, fixture, aliases);
    if (fromId) return fromId;
  }
  return resolveWinnerUserId(winner, fixture, aliases);
}

function resolvedWinnerUserId(fixture, aliases = {}) {
  if (!fixture) return null;
  if (fixture.winnerUserId) {
    if (idsEqual(fixture.winnerUserId, fixture.team1UserId)) return fixture.team1UserId;
    if (idsEqual(fixture.winnerUserId, fixture.team2UserId)) return fixture.team2UserId;
  }
  return resolveWinnerUserId(fixture.winner, fixture, aliases);
}

function resolveWinnerName(winner, fixture, aliases = {}) {
  if (!winner || !fixture) return winner;
  const winnerUserId = pickWinnerUserId(winner, fixture, aliases);
  if (idsEqual(winnerUserId, fixture.team1UserId)) return aliases.team1 || fixture.team1;
  if (idsEqual(winnerUserId, fixture.team2UserId)) return aliases.team2 || fixture.team2;
  return aliases.team1 && idsEqual(winnerUserId, fixture.team1UserId)
    ? aliases.team1
    : winner;
}

function userIsTeam1(fixture, userId) {
  return idsEqual(userId, fixture?.team1UserId);
}

function userIsTeam2(fixture, userId) {
  return idsEqual(userId, fixture?.team2UserId);
}

function userOnFixture(fixture, userId) {
  return userIsTeam1(fixture, userId) || userIsTeam2(fixture, userId);
}

function userWonFixture(fixture, userId, aliases = {}) {
  return idsEqual(resolvedWinnerUserId(fixture, aliases), userId);
}

function sameTeam(a, b) {
  const ka = normalizeTeamKey(a);
  const kb = normalizeTeamKey(b);
  return Boolean(ka && kb && ka === kb);
}

module.exports = {
  normalizeTeamKey,
  idStr,
  idsEqual,
  resolveWinnerUserId,
  pickWinnerUserId,
  resolvedWinnerUserId,
  resolveWinnerName,
  userIsTeam1,
  userIsTeam2,
  userOnFixture,
  userWonFixture,
  sameTeam,
};
