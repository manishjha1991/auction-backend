// Database health check middleware
const mongoose = require('mongoose');

// Connection health check
const checkDBHealth = (req, res, next) => {
  const connectionState = mongoose.connection.readyState;
  
  // Connection states: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  if (connectionState !== 1) {
    console.warn(`⚠️ Database connection issue. State: ${connectionState}`);
    
    // If connection is lost, try to reconnect
    if (connectionState === 0) {
      console.log('🔄 Attempting to reconnect to MongoDB...');
      mongoose.connect(process.env.MONGO_URI, {
        dbName: 'cpl_12',
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 10000,
        maxPoolSize: 10,
        minPoolSize: 5,
        bufferMaxEntries: 0,
        bufferCommands: false
      }).catch(err => {
        console.error('❌ Reconnection failed:', err.message);
      });
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
