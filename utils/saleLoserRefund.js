/**
 * Fields required when loading users for post-sale loser refunds.
 * Omitting `purse` causes TypeError on user.purse.toString() after the winner
 * has already been charged — leaving locked funds stuck and the player unsold.
 */
const SALE_LOSER_USER_SELECT = '_id currentBids purse';

/**
 * Refund locked currentBids amounts for non-winning bidders and clear the lot.
 * @param {object} opts
 * @param {import('mongoose')} opts.mongoose
 * @param {import('mongoose').Types.ObjectId|string} opts.playerId
 * @param {import('mongoose').Types.ObjectId|string} opts.winnerId
 * @param {Array<{_id: any, purse: any, currentBids: any[], save: Function}>} opts.users
 */
async function refundOtherBiddersForSoldPlayer({ mongoose, playerId, winnerId, users }) {
  const pid = playerId?.toString?.() ?? String(playerId);
  const wid = winnerId?.toString?.() ?? String(winnerId);

  for (const user of users) {
    if (user._id.toString() === wid) {
      continue;
    }

    const userBid = (user.currentBids || []).find(
      (cb) => cb.playerId && cb.playerId.toString() === pid
    );
    if (!userBid) {
      continue;
    }

    if (user.purse == null) {
      throw new Error(
        `Missing purse on user ${user._id} while refunding sale of player ${pid}`
      );
    }

    const lockedAmount = userBid.amount || 0;
    const purse = parseFloat(user.purse.toString());
    user.purse = mongoose.Types.Decimal128.fromString(
      (purse + lockedAmount).toString()
    );
    user.currentBids = user.currentBids.filter(
      (cb) => !(cb.playerId && cb.playerId.toString() === pid)
    );
    await user.save();
  }
}

module.exports = {
  SALE_LOSER_USER_SELECT,
  refundOtherBiddersForSoldPlayer,
};
