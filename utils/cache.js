/**
 * Centralized caching utility for backend routes
 * Provides consistent caching across all endpoints
 */
const NodeCache = require('node-cache');
const { trackCacheHit, trackCacheMiss, trackCacheSet } = require('./cacheMonitor');

// Create cache instances with different TTLs for different data types
const cacheConfig = {
  // Short cache (30 seconds) - for frequently changing data
  short: new NodeCache({ stdTTL: 30, checkperiod: 10 }),
  
  // Medium cache (2 minutes) - for moderately changing data
  medium: new NodeCache({ stdTTL: 120, checkperiod: 30 }),
  
  // Long cache (5 minutes) - for relatively static data
  long: new NodeCache({ stdTTL: 300, checkperiod: 60 }),
  
  // Very long cache (15 minutes) - for mostly static data
  veryLong: new NodeCache({ stdTTL: 900, checkperiod: 120 })
};

/**
 * Cache middleware factory
 * @param {string} cacheType - 'short', 'medium', 'long', or 'veryLong'
 * @param {string} keyGenerator - Function to generate cache key from request
 * @returns {Function} Express middleware
 */
const cacheMiddleware = (cacheType = 'medium', keyGenerator = null) => {
  const cache = cacheConfig[cacheType];
  
  return (req, res, next) => {
    // Generate cache key
    const cacheKey = keyGenerator 
      ? keyGenerator(req)
      : `cache:${req.method}:${req.originalUrl}:${JSON.stringify(req.query)}:${JSON.stringify(req.params)}`;
    
    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      trackCacheHit(cacheType, cacheKey);
      console.log(`✅ Cache HIT: ${cacheKey}`);
      return res.status(200).json(cached);
    }
    
    trackCacheMiss(cacheType, cacheKey);
    
    // Store original json method
    const originalJson = res.json.bind(res);
    
    // Override json method to cache response
    res.json = function(data) {
      cache.set(cacheKey, data);
      trackCacheSet(cacheType, cacheKey);
      console.log(`💾 Cache SET: ${cacheKey}`);
      return originalJson(data);
    };
    
    next();
  };
};

/**
 * Invalidate cache by pattern
 * @param {string} pattern - Pattern to match cache keys
 */
const invalidateCache = (pattern) => {
  Object.values(cacheConfig).forEach(cache => {
    const keys = cache.keys();
    keys.forEach(key => {
      if (key.includes(pattern)) {
        cache.del(key);
        console.log(`🗑️ Cache invalidated: ${key}`);
      }
    });
  });
};

// Optional hook: playerStats registers a no-arg fn to delete its stats-overview cache key
let statsOverviewInvalidator = () => {};
const registerStatsOverviewInvalidator = (fn) => {
  if (typeof fn === 'function') statsOverviewInvalidator = fn;
};
const flushStatsOverviewCache = () => {
  try {
    statsOverviewInvalidator();
  } catch (e) {
    console.warn('stats-overview cache invalidation failed:', e.message);
  }
};

// Extra caches (e.g. playerStats stats-overview) registered by route modules
const extraCaches = [];

/**
 * Register an extra cache to be cleared when clearAllCaches is called
 * @param {NodeCache} cache - NodeCache instance
 */
const registerExtraCache = (cache) => {
  if (cache && typeof cache.flushAll === 'function') {
    extraCaches.push(cache);
  }
};

/**
 * Clear all caches (cacheConfig + any registered extra caches)
 */
const clearAllCaches = () => {
  Object.values(cacheConfig).forEach(cache => {
    cache.flushAll();
  });
  extraCaches.forEach(cache => {
    try {
      cache.flushAll();
    } catch (e) {
      console.warn('Failed to flush extra cache:', e.message);
    }
  });
  console.log('🗑️ All caches cleared');
};

module.exports = {
  cacheConfig,
  cacheMiddleware,
  invalidateCache,
  clearAllCaches,
  registerExtraCache,
  registerStatsOverviewInvalidator,
  flushStatsOverviewCache,
};

