/**
 * Reentrant per-player mutex: nested withPlayerBidLock for same playerId runs inline so bid queue + promotion + proxy do not deadlock.
 */

const chains = new Map();
const depth = new Map();

function withPlayerBidLock(playerId, fn) {
  const key = String(playerId);
  const d = depth.get(key) || 0;
  if (d > 0) {
    depth.set(key, d + 1);
    return Promise.resolve()
      .then(() => fn())
      .finally(() => {
        const v = depth.get(key) - 1;
        if (v <= 0) depth.delete(key);
        else depth.set(key, v);
      });
  }

  const prev = chains.get(key) || Promise.resolve();
  const next = prev
    .then(async () => {
      depth.set(key, (depth.get(key) || 0) + 1);
      try {
        return await fn();
      } finally {
        const v = (depth.get(key) || 1) - 1;
        if (v <= 0) depth.delete(key);
        else depth.set(key, v);
      }
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
