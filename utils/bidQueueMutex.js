const { AsyncLocalStorage } = require("async_hooks");

/**
 * Reentrant per-player mutex. Nested calls for a lock already held by the same
 * async execution run inline; concurrent requests for that player are queued.
 */
const chains = new Map();
const lockContext = new AsyncLocalStorage();

function withPlayerBidLock(playerId, fn) {
  const key = String(playerId);
  const heldLocks = lockContext.getStore();

  if (heldLocks?.has(key)) {
    return Promise.resolve().then(fn);
  }

  const prev = chains.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {
      // Keep the queue moving even if the previous lock holder failed.
    })
    .then(() => {
      const nextHeldLocks = new Set(heldLocks || []);
      nextHeldLocks.add(key);
      return lockContext.run(nextHeldLocks, fn);
    });

  chains.set(key, next);

  return next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });
}

module.exports = { withPlayerBidLock };
