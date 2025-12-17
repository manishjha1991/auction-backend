/**
 * Cache Monitoring Utility
 * Tracks cache hits, misses, and performance
 */

// Lazy load cacheConfig to avoid circular dependency
let cacheConfig = null;
const getCacheConfig = () => {
  if (!cacheConfig) {
    cacheConfig = require('./cache').cacheConfig;
  }
  return cacheConfig;
};

// Cache statistics
const cacheStats = {
  hits: {},
  misses: {},
  sets: {},
  totalRequests: 0
};

/**
 * Track cache hit
 */
const trackCacheHit = (cacheType, key) => {
  cacheStats.totalRequests++;
  if (!cacheStats.hits[cacheType]) {
    cacheStats.hits[cacheType] = 0;
  }
  cacheStats.hits[cacheType]++;
  
  if (process.env.NODE_ENV !== 'production') {
    console.log(`✅ Cache HIT [${cacheType}]: ${key.substring(0, 50)}...`);
  }
};

/**
 * Track cache miss
 */
const trackCacheMiss = (cacheType, key) => {
  cacheStats.totalRequests++;
  if (!cacheStats.misses[cacheType]) {
    cacheStats.misses[cacheType] = 0;
  }
  cacheStats.misses[cacheType]++;
  
  if (process.env.NODE_ENV !== 'production') {
    console.log(`❌ Cache MISS [${cacheType}]: ${key.substring(0, 50)}...`);
  }
};

/**
 * Track cache set
 */
const trackCacheSet = (cacheType, key) => {
  if (!cacheStats.sets[cacheType]) {
    cacheStats.sets[cacheType] = 0;
  }
  cacheStats.sets[cacheType]++;
};

/**
 * Get cache statistics
 */
const getCacheStats = () => {
  try {
    // Ensure cacheStats is initialized
    if (!cacheStats || typeof cacheStats !== 'object') {
      return {
        totalRequests: 0,
        byType: {},
        overall: {
          hits: 0,
          misses: 0,
          sets: 0,
          hitRate: '0%'
        }
      };
    }
    
    // Lazy load cacheConfig
    const config = getCacheConfig();
    if (!config || typeof config !== 'object') {
      return {
        totalRequests: cacheStats.totalRequests || 0,
        byType: {},
        overall: {
          hits: 0,
          misses: 0,
          sets: 0,
          hitRate: '0%'
        }
      };
    }
    
    const stats = {
      totalRequests: cacheStats.totalRequests || 0,
      byType: {},
      overall: {
        hits: 0,
        misses: 0,
        sets: 0,
        hitRate: '0%'
      }
    };
    
    // Calculate stats by cache type
    const cacheTypes = Object.keys(config);
    if (cacheTypes.length > 0) {
      cacheTypes.forEach(type => {
        const hits = (cacheStats.hits && cacheStats.hits[type]) || 0;
        const misses = (cacheStats.misses && cacheStats.misses[type]) || 0;
        const sets = (cacheStats.sets && cacheStats.sets[type]) || 0;
        const total = hits + misses;
        const hitRate = total > 0 ? ((hits / total) * 100).toFixed(2) : '0.00';
        
        stats.byType[type] = {
          hits,
          misses,
          sets,
          total,
          hitRate: `${hitRate}%`
        };
        
        stats.overall.hits += hits;
        stats.overall.misses += misses;
        stats.overall.sets += sets;
      });
    }
    
    // Calculate overall hit rate
    const totalRequests = stats.overall.hits + stats.overall.misses;
    stats.overall.hitRate = totalRequests > 0 
      ? `${((stats.overall.hits / totalRequests) * 100).toFixed(2)}%`
      : '0%';
    
    return stats;
  } catch (error) {
    console.error('Error in getCacheStats:', error);
    return {
      totalRequests: 0,
      byType: {},
      overall: {
        hits: 0,
        misses: 0,
        sets: 0,
        hitRate: '0%'
      }
    };
  }
};

/**
 * Reset cache statistics
 */
const resetCacheStats = () => {
  cacheStats.hits = {};
  cacheStats.misses = {};
  cacheStats.sets = {};
  cacheStats.totalRequests = 0;
};

/**
 * Get cache keys count
 */
const getCacheKeysCount = () => {
  try {
    const counts = {};
    // Lazy load cacheConfig
    const config = getCacheConfig();
    if (!config || typeof config !== 'object') {
      return counts;
    }
    
    const cacheTypes = Object.keys(config);
    cacheTypes.forEach(type => {
      try {
        const cacheInstance = config[type];
        if (cacheInstance && typeof cacheInstance.keys === 'function') {
          counts[type] = cacheInstance.keys().length;
        } else {
          counts[type] = 0;
        }
      } catch (err) {
        console.error(`Error getting keys count for cache type ${type}:`, err);
        counts[type] = 0;
      }
    });
    return counts;
  } catch (error) {
    console.error('Error in getCacheKeysCount:', error);
    return {};
  }
};

module.exports = {
  trackCacheHit,
  trackCacheMiss,
  trackCacheSet,
  getCacheStats,
  resetCacheStats,
  getCacheKeysCount
};

