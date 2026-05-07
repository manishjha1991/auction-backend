/**
 * Monitoring and Performance Routes
 * Provides endpoints to monitor system performance, cache stats, and query metrics
 */

const express = require('express');
const router = express.Router();
const { getPerformanceStats } = require('../utils/performanceMonitor');
const { getCacheStats, getCacheKeysCount } = require('../utils/cacheMonitor');
const { getRoutePerfSnapshot, resetRoutePerfStats } = require('../utils/routePerfMonitor');
const mongoose = require('mongoose');

/**
 * GET /api/monitoring/performance
 * Get current performance statistics
 */
router.get('/performance', (req, res) => {
  try {
    const stats = getPerformanceStats();
    // Ensure stats is a valid object before spreading
    const safeStats = stats && typeof stats === 'object' ? stats : {
      queryCount: 0,
      queryTimes: [],
      totalQueryTime: 0,
      avgQueryTime: 0,
      leanQueries: 0,
      regularQueries: 0
    };
    
    res.json({
      success: true,
      data: {
        ...safeStats,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/monitoring/cache
 * Get cache statistics
 */
router.get('/cache', (req, res) => {
  try {
    // Safely get stats with error handling
    let stats = {
      totalRequests: 0,
      byType: {},
      overall: {
        hits: 0,
        misses: 0,
        sets: 0,
        hitRate: '0%'
      }
    };
    let keysCount = {};
    
    try {
      stats = getCacheStats() || stats;
    } catch (err) {
      console.error('Error getting cache stats:', err);
    }
    
    try {
      keysCount = getCacheKeysCount() || {};
    } catch (err) {
      console.error('Error getting cache keys count:', err);
    }
    
    // Ensure stats is a valid object before spreading
    const safeStats = stats && typeof stats === 'object' ? stats : {
      totalRequests: 0,
      byType: {},
      overall: {
        hits: 0,
        misses: 0,
        sets: 0,
        hitRate: '0%'
      }
    };
    
    res.json({
      success: true,
      data: {
        ...safeStats,
        keysCount: keysCount && typeof keysCount === 'object' ? keysCount : {},
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Cache monitoring error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
});

/**
 * GET /api/monitoring/database
 * Get database connection and pool statistics
 */
router.get('/database', (req, res) => {
  try {
    const connection = mongoose.connection;
    const pool = connection.db?.s?.topology?.s?.pool;
    
    const stats = {
      connection: {
        state: connection.readyState,
        stateText: getConnectionStateText(connection.readyState),
        host: connection.host,
        database: connection.name,
        port: connection.port
      },
      pool: pool ? {
        totalConnections: pool.totalConnectionCount || 0,
        availableConnections: pool.availableConnectionCount || 0,
        checkedOutConnections: pool.checkedOutConnections || 0,
        waitQueueLength: pool.waitQueueLength || 0,
        maxPoolSize: pool.options?.maxPoolSize || 0,
        minPoolSize: pool.options?.minPoolSize || 0,
        utilization: pool.totalConnectionCount > 0 
          ? ((pool.checkedOutConnections / pool.totalConnectionCount) * 100).toFixed(2) + '%'
          : '0%'
      } : null,
      timestamp: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/monitoring/health
 * Overall system health check
 */
router.get('/health', async (req, res) => {
  try {
    const connection = mongoose.connection;
    
    // Safely get stats with error handling
    let perfStats = { queryCount: 0, avgQueryTime: 0, leanQueries: 0, regularQueries: 0 };
    let cacheStats = { overall: { hitRate: '0%' }, totalRequests: 0 };
    
    try {
      perfStats = getPerformanceStats() || perfStats;
    } catch (err) {
      console.error('Error getting performance stats:', err);
    }
    
    try {
      cacheStats = getCacheStats() || cacheStats;
    } catch (err) {
      console.error('Error getting cache stats:', err);
    }
    
    // Ensure perfStats has all required properties
    if (!perfStats || typeof perfStats !== 'object') {
      perfStats = { queryCount: 0, avgQueryTime: 0, leanQueries: 0, regularQueries: 0 };
    }
    
    // Ensure cacheStats has all required properties
    if (!cacheStats || typeof cacheStats !== 'object') {
      cacheStats = { overall: { hitRate: '0%' }, totalRequests: 0 };
    }
    
    // Ensure overall exists
    if (!cacheStats.overall || typeof cacheStats.overall !== 'object') {
      cacheStats.overall = { hitRate: '0%' };
    }
    
    const health = {
      status: 'healthy',
      database: {
        connected: connection && connection.readyState === 1,
        state: connection ? getConnectionStateText(connection.readyState) : 'unknown'
      },
      performance: {
        avgQueryTime: (perfStats.avgQueryTime || 0).toFixed(2) + 'ms',
        totalQueries: perfStats.queryCount || 0,
        leanQueries: perfStats.leanQueries || 0,
        regularQueries: perfStats.regularQueries || 0
      },
      cache: {
        hitRate: (cacheStats.overall && cacheStats.overall.hitRate) || '0%',
        totalRequests: cacheStats.totalRequests || 0
      },
      timestamp: new Date().toISOString()
    };
    
    // Check for issues
    if (connection && connection.readyState !== 1) {
      health.status = 'degraded';
      health.issues = ['Database not connected'];
    }
    
    if (perfStats.avgQueryTime && perfStats.avgQueryTime > 100) {
      health.status = health.status === 'healthy' ? 'warning' : health.status;
      if (!health.issues) health.issues = [];
      health.issues.push('High average query time');
    }
    
    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
});

/**
 * GET /api/monitoring/route-performance
 * Per-route latency metrics (rolling window)
 */
router.get('/route-performance', (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const contains = typeof req.query.contains === 'string' ? req.query.contains : '';
    const method = typeof req.query.method === 'string' ? req.query.method : '';
    const data = getRoutePerfSnapshot({ limit, contains, method });
    res.json({
      success: true,
      data: {
        routes: data,
        filters: {
          contains: contains || null,
          method: method || null,
          limit,
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/monitoring/route-performance/reset
 * Reset rolling route-performance stats
 */
router.post('/route-performance/reset', (req, res) => {
  try {
    resetRoutePerfStats();
    res.json({
      success: true,
      message: 'Route performance stats reset successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Helper function to get connection state text
 */
function getConnectionStateText(state) {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
    99: 'uninitialized'
  };
  return states[state] || 'unknown';
}

module.exports = router;

