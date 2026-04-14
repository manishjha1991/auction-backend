/**
 * Single source of truth for auction bid steps (mirrors legacy bidRoutes logic).
 */

function determineBidIncrement(playerType, lastBidAmount) {
  if (["Sapphire", "Gold", "Emerald"].includes(playerType)) {
    return 5000000;
  }
  if (playerType === "Silver" && lastBidAmount >= 10000000) {
    return 5000000;
  }
  if (playerType === "Silver") {
    return 1000000;
  }
  return 1000000;
}

/**
 * @param {object} player - Player doc with type, basePrice
 * @param {{ bidAmount: number } | null} highestBid - top active bid lean doc or null
 * @returns {number}
 */
function computeNextBidAmount(player, highestBid) {
  if (!highestBid) {
    return player.basePrice;
  }
  const inc = determineBidIncrement(player.type, highestBid.bidAmount);
  return highestBid.bidAmount + inc;
}

/** How many minimum legal bid steps from current auction top until the next bid would exceed maxBid. */
function countBidStepsUntilExceedingMax(player, highestBidLean, maxBid) {
  let highest = highestBidLean;
  for (let steps = 0; steps < 500; steps++) {
    const next = computeNextBidAmount(player, highest);
    if (next > maxBid) return steps;
    highest = { bidAmount: next };
  }
  return 999;
}

module.exports = {
  determineBidIncrement,
  computeNextBidAmount,
  countBidStepsUntilExceedingMax,
};
