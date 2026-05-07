// 🚀 Enhanced Database Health Check with Connection Pooling
const mongoose = require('mongoose');

let reconnectPromise = null;
let lastReconnectAttemptAt = 0;
const RECONNECT_COOLDOWN_MS = 15000;

function buildReconnectOptions() {
  const poolMax = parseInt(process.env.MONGO_MAX_POOL_SIZE || '3', 10);
  const poolMin = parseInt(process.env.MONGO_MIN_POOL_SIZE || '0', 10);
  const envDbName = (process.env.MONGO_DB_NAME || '').trim();
  return {
    ...(envDbName ? { dbName: envDbName } : {}),
    useNewUrlParser: true,
    useUnifiedTopology: true,
    maxPoolSize: Number.isFinite(poolMax) ? poolMax : 3,
    minPoolSize: Number.isFinite(poolMin) ? poolMin : 0,
    maxIdleTimeMS: 60000,
    maxConnecting: 2,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 30000,
    connectTimeoutMS: 15000,
    retryWrites: true,
    retryReads: true,
    heartbeatFrequencyMS: 5000,
    compressors: ['zlib'],
    zlibCompressionLevel: 6,
    // SRV URIs (mongodb+srv://) do NOT support directConnection
    directConnection: (process.env.MONGO_URI || '').startsWith('mongodb+srv://') ? false : (process.env.MONGO_DIRECT_CONNECTION === 'true'),
    monitorCommands: process.env.NODE_ENV !== 'production',
    readPreference: (process.env.MONGO_URI || '').startsWith('mongodb+srv://') ? 'primaryPreferred' : (process.env.MONGO_DIRECT_CONNECTION === 'true' ? 'primary' : 'primaryPreferred'),
    readConcern: { level: 'local' },
    writeConcern: { w: 1, j: true }
  };
}

async function safeReconnectIfNeeded() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ Cannot reconnect: MONGO_URI is missing.');
    return;
  }

  const now = Date.now();
  if (reconnectPromise) return;
  if (now - lastReconnectAttemptAt < RECONNECT_COOLDOWN_MS) return;

  lastReconnectAttemptAt = now;
  reconnectPromise = mongoose.connect(mongoUri, buildReconnectOptions())
    .then(() => {
      console.log('✅ MongoDB reconnected');
    })
    .catch((err) => {
      console.error('❌ Reconnection failed:', err.message);
    })
    .finally(() => {
      reconnectPromise = null;
    });
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
      safeReconnectIfNeeded();
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
