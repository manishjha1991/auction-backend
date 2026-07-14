/**
 * Reentrant per-player mutex: nested withPlayerBidLock for same playerId runs inline so bid queue + promotion + proxy do not deadlock.
 */

const { AsyncLocalStorage } = require("node:async_hooks");

const chains = new Map();
const lockContext = new AsyncLocalStorage();

function withPlayerBidLock(playerId, fn) {
  const key = String(playerId);
  const heldLocks = lockContext.getStore();
  if (heldLocks?.has(key)) {
    return Promise.resolve().then(fn);
  }

  const previous = chains.get(key) || Promise.resolve();
  let next;
  next = previous
    .catch(() => undefined)
    .then(() => {
      const nextHeldLocks = new Set(lockContext.getStore() || []);
      nextHeldLocks.add(key);
      return lockContext.run(nextHeldLocks, fn);
    })
    .finally(() => {
      if (chains.get(key) === next) {
        chains.delete(key);
      }
    });
  chains.set(key, next);
  return next;
}

module.exports = { withPlayerBidLock };
