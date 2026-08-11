/**
 * Split roster engagement into bought vs in-progress bids by player type.
 * Bidding player IDs must not be mixed into the bought bucket (avoids double-count).
 *
 * @param {Array<{ _id: *, type: string }>} players - Player docs for bought + bidding ids
 * @param {Array} boughtPlayerIds
 * @param {Array<{ playerId: * }>} currentBids
 * @returns {{ boughtCounts: Record<string, number>, biddingCounts: Record<string, number> }}
 */
function countBoughtAndBiddingByType(players, boughtPlayerIds, currentBids) {
  const typeById = new Map(
    (players || []).map((p) => [p._id.toString(), p.type])
  );

  const boughtCounts = {};
  for (const id of boughtPlayerIds || []) {
    const t = typeById.get(id.toString());
    if (!t) continue;
    boughtCounts[t] = (boughtCounts[t] || 0) + 1;
  }

  const biddingCounts = {};
  for (const bid of currentBids || []) {
    if (!bid?.playerId) continue;
    const t = typeById.get(bid.playerId.toString());
    if (!t) continue;
    biddingCounts[t] = (biddingCounts[t] || 0) + 1;
  }

  return { boughtCounts, biddingCounts };
}

module.exports = { countBoughtAndBiddingByType };
