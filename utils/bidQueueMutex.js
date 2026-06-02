/**
 * Reentrant per-player mutex.
 *
 * Nested withPlayerBidLock calls for the same player run inline within the same
 * async call chain, while separate requests still serialize behind the chain.
 */

const { AsyncLocalStorage } = require("async_hooks");

const chains = new Map();
const heldLocksStorage = new AsyncLocalStorage();

function withPlayerBidLock(playerId, fn) {
  const key = String(playerId);
  const heldLocks = heldLocksStorage.getStore();

  if (heldLocks?.has(key)) {
    return Promise.resolve().then(() => fn());
  }

  const previous = chains.get(key) || Promise.resolve();
  const run = previous
    .catch(() => {
      // A failed prior lock holder must not poison the queue for future callers.
    })
    .then(() => {
      const nextHeldLocks = new Set(heldLocks || []);
      nextHeldLocks.add(key);
      return heldLocksStorage.run(nextHeldLocks, () => Promise.resolve().then(() => fn()));
    });

  const next = run.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });

  chains.set(key, next);
  return next;
}

module.exports = { withPlayerBidLock };
