// 🚀 Enhanced Database Health Check with Connection Pooling
const mongoose = require('mongoose');

function getReconnectOptions() {
  const options = {
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
    writeConcern: { w: 1, j: true },
  };
  if (process.env.MONGO_DB_NAME) {
    options.dbName = process.env.MONGO_DB_NAME;
  }
  return options;
}

// Connection health check with pool monitoring
const checkDBHealth = (req, res, next) => {
  const connectionState = mongoose.connection.readyState;
  const pool = mongoose.connection.db?.s?.topology?.s?.pool;
  
  // Connection states: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (connectionState !== 1) {
    console.warn(`⚠️ Database connection issue. State: ${connectionState}`);
    
    // If connection is lost, try to reconnect with optimized settings
    if (connectionState === 0) {
      console.log('🔄 Attempting to reconnect to MongoDB with optimized pooling...');
      if (!process.env.MONGO_URI) {
        console.error('❌ Reconnection skipped: MONGO_URI is missing');
      } else {
        mongoose
          .connect(process.env.MONGO_URI, getReconnectOptions())
          .catch((err) => {
            console.error('❌ Reconnection failed:', err.message);
          });
      }
    }
  }
  
  // Monitor connection pool health
  if (pool && connectionState === 1) {
    const utilization = pool.totalConnectionCount > 0 ? 
      (pool.checkedOutConnections / pool.totalConnectionCount) * 100 : 0;
    
    // Warn if pool utilization is high
    if (utilization > 80) {
      console.warn(`⚠️ High connection pool utilization: ${utilization.toFixed(1)}%`);
    }
    
    // Warn if wait queue is growing
    if (pool.waitQueueLength > 5) {
      console.warn(`⚠️ Connection pool wait queue: ${pool.waitQueueLength} requests waiting`);
    }
  }
  
  next();
};

// Database operation wrapper with retry logic
const withRetry = async (operation, maxRetries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`❌ Database operation failed (attempt ${attempt}/${maxRetries}):`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
};

// Enhanced query wrapper
const safeQuery = async (queryFunction, fallbackValue = null) => {
  try {
    return await withRetry(queryFunction);
  } catch (error) {
    console.error('❌ Safe query failed:', error.message);
    return fallbackValue;
  }
};

module.exports = {
  checkDBHealth,
  withRetry,
  safeQuery
};
