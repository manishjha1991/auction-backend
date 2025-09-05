// Connection Pool Management API
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Get connection pool status
router.get('/status', (req, res) => {
  try {
    const connection = mongoose.connection;
    const pool = connection.db?.s?.topology?.s?.pool;
    
    const status = {
      connectionState: connection.readyState,
      connectionStateText: getConnectionStateText(connection.readyState),
      host: connection.host,
      database: connection.name,
      pool: pool ? {
        totalConnections: pool.totalConnectionCount || 0,
        availableConnections: pool.availableConnectionCount || 0,
        checkedOutConnections: pool.checkedOutConnections || 0,
        waitQueueLength: pool.waitQueueLength || 0,
        maxPoolSize: pool.options?.maxPoolSize || 0,
        minPoolSize: pool.options?.minPoolSize || 0
      } : null,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get connection pool metrics
router.get('/metrics', (req, res) => {
  try {
    const connection = mongoose.connection;
    const pool = connection.db?.s?.topology?.s?.pool;
    
    const metrics = {
      connection: {
        state: connection.readyState,
        host: connection.host,
        database: connection.name
      },
      pool: pool ? {
        totalConnections: pool.totalConnectionCount || 0,
        availableConnections: pool.availableConnectionCount || 0,
        checkedOutConnections: pool.checkedOutConnections || 0,
        waitQueueLength: pool.waitQueueLength || 0,
        utilization: pool.totalConnectionCount > 0 ? 
          ((pool.checkedOutConnections / pool.totalConnectionCount) * 100).toFixed(2) + '%' : '0%'
      } : null,
      performance: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage()
      },
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test connection pool performance
router.get('/test', async (req, res) => {
  try {
    const { queries = 10 } = req.query;
    const numQueries = Math.min(parseInt(queries), 100); // Max 100 queries
    
    const User = require('../models/User');
    const times = [];
    
    console.log(`🧪 Testing connection pool with ${numQueries} queries...`);
    
    for (let i = 0; i < numQueries; i++) {
      const start = Date.now();
      await User.findOne().lean();
      const duration = Date.now() - start;
      times.push(duration);
    }
    
    const stats = {
      queries: numQueries,
      averageTime: (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
      totalTime: times.reduce((a, b) => a + b, 0),
      times: times
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

// Force connection pool refresh
router.post('/refresh', async (req, res) => {
  try {
    console.log('🔄 Refreshing connection pool...');
    
    // Close existing connections
    await mongoose.connection.close();
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Reconnect with current options
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: 'cpl_12',
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 20,
      minPoolSize: 8,
      maxIdleTimeMS: 60000,
      maxConnecting: 5,
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 15000,
      retryWrites: true,
      retryReads: true,
      heartbeatFrequencyMS: 5000,
      compressors: ['zlib'],
      zlibCompressionLevel: 6,
      directConnection: false,
      monitorCommands: true,
      maxStalenessSeconds: 90,
      readPreference: 'primaryPreferred',
      readConcern: { level: 'local' },
      writeConcern: { w: 1, j: true }
    });
    
    res.json({
      success: true,
      message: 'Connection pool refreshed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper function to get connection state text
function getConnectionStateText(state) {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  return states[state] || 'unknown';
}

module.exports = router;
