/**
 * Season-reset helpers for keeping retained players when releasing the rest.
 *
 * Array.prototype.includes uses reference equality. Mongoose ObjectIds with the
 * same hex from different queries are distinct objects, so
 * retainedIds.includes(player._id) is always false and would release retained
 * players. Compare string forms instead.
 */

function idKey(value) {
  if (value == null) return null;
  if (typeof value === 'object' && value._id != null) {
    return String(value._id);
  }
  const key = String(value);
  return key && key !== 'undefined' ? key : null;
}

function retainedPlayerIdSet(retainedPlayers = []) {
  const ids = new Set();
  for (const rp of retainedPlayers) {
    const key = idKey(rp && rp.playerId);
    if (key) ids.add(key);
  }
  return ids;
}

function filterSoldPlayersExcludingRetained(soldPlayers = [], retainedPlayers = []) {
  const retainedIds = retainedPlayerIdSet(retainedPlayers);
  return soldPlayers.filter((player) => {
    const key = idKey(player && player._id);
    return Boolean(key) && !retainedIds.has(key);
  });
}

module.exports = {
  idKey,
  retainedPlayerIdSet,
  filterSoldPlayersExcludingRetained,
};
