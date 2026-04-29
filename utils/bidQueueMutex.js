const { AsyncLocalStorage } = require("async_hooks");

/**
 * Reentrant per-player mutex: nested withPlayerBidLock for the same async call
 * runs inline so bid queue + promotion + proxy do not deadlock.
 */

const chains = new Map();
const heldLocks = new AsyncLocalStorage();

function withPlayerBidLock(playerId, fn) {
  const key = String(playerId);
  const currentLocks = heldLocks.getStore();
  if (currentLocks?.has(key)) {
    return Promise.resolve().then(() => fn());
  }

  const prev = chains.get(key) || Promise.resolve();
  const run = prev
    .catch(() => {
      // Previous callers receive their own error; keep the queue moving.
    })
    .then(async () => {
      const nextLocks = new Set(currentLocks || []);
      nextLocks.add(key);
      return heldLocks.run(nextLocks, fn);
    })
    .finally(() => {
      if (chains.get(key) === run) {
        chains.delete(key);
      }
    });
  chains.set(key, run);
  return run;
}

module.exports = { withPlayerBidLock };
