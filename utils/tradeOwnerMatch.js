/**
 * Approve must run against the parties recorded on the TradeRequest.
 * Current UserPlayer owners can drift (release→repick, commissioner moves) while a
 * request stays admin_pending; swapping from current owners would move the wrong
 * teams' players and still increment tradesUsed on fromUser/toUser.
 */

function refId(ref) {
  return ref?._id || ref;
}

function tradePartiesMatchCurrentOwners(tradeDoc, offeredOwnerId, requestedOwnerId) {
  const fromId = refId(tradeDoc?.fromUser);
  const toId = refId(tradeDoc?.toUser);
  const offeredId = refId(offeredOwnerId);
  const requestedId = refId(requestedOwnerId);
  if (fromId == null || toId == null || offeredId == null || requestedId == null) {
    return false;
  }
  return String(offeredId) === String(fromId) && String(requestedId) === String(toId);
}

module.exports = {
  tradePartiesMatchCurrentOwners,
};
