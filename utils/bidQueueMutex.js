/**
 * Reentrant per-player mutex: nested withPlayerBidLock for same playerId runs inline so bid queue + promotion + proxy do not deadlock.
 */

const { AsyncLocalStorage } = require("async_hooks");

const chains = new Map();
const heldLocks = new AsyncLocalStorage();

function withPlayerBidLock(playerId, fn) {
  const key = String(playerId);
  const currentLocks = heldLocks.getStore();
  if (currentLocks?.has(key)) {
    return Promise.resolve().then(() => fn());
  }

  const prev = chains.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {
      // Keep the queue moving even if a prior critical section failed.
    })
    .then(async () => {
      const nextLocks = new Set(heldLocks.getStore() || []);
      nextLocks.add(key);
      return heldLocks.run(nextLocks, fn);
    })
    .catch((err) => {
      throw err;
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
