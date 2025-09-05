require('dotenv').config();
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const mongoose = require('mongoose');

const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');

const playerRoutes = require('./routes/players'); // Adjust the path as needed
const userRoutes = require('./routes/user'); // Adjust the path
const bidRoutes = require('./routes/bidRoutes'); // Import bid routes
const playerStatsRoutes = require('./routes/playerStats'); // Adjust path
const fixtureRoutes = require('./routes/fixture'); // Adjust path
const app = express();
const server = http.createServer(app);
const notificationRoutes = require('./routes/notifications');
const releaseRoutes = require('./routes/releases');
const pickRoutes = require('./routes/picks');
const newsRoutes = require('./routes/news');
const settingsRoutes = require('./routes/settings');
const io = new Server(server, { cors: { origin: '*' } });
const tradeRoutes = require('./routes/trades');
const liveScoreRoutes = require('./routes/livescores');
const commentRoutes = require('./routes/comments');
const postLikeRoutes = require('./routes/postLikes');
const playoffFixtureRoutes = require('./routes/playoffFixtures');
const scheduleRoutes = require('./routes/schedules');
const indexRoutes = require('./routes/indexes');
const connectionPoolRoutes = require('./routes/connectionPool');
const { cacheConfigs, getCacheStats, invalidateCache } = require('./middleware/cache');
const { smartETagMiddleware, conditionalRequestMiddleware } = require('./middleware/etags');
const { smartDeduplicationMiddleware, requestQueueMiddleware } = require('./middleware/deduplication');
const { queryMonitorMiddleware, performanceMonitorMiddleware, getQueryStats } = require('./middleware/queryMonitor');
const { smartJSONOptimization, responseSizeMiddleware } = require('./middleware/jsonOptimizer');

app.set('io', io);

// 🚀 PERFORMANCE MIDDLEWARE STACK
// Security and compression
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for development
  crossOriginEmbedderPolicy: false
}));

// Response compression - DISABLED TO FIX DECODING ERRORS
// app.use(compression({
//   level: 6, // Compression level (1-9, 6 is good balance)
//   threshold: 1024, // Only compress responses > 1KB
//   filter: (req, res) => {
//     // Skip compression for certain content types that might cause issues
//     if (req.headers['x-no-compression']) return false;
//     if (req.path.includes('/api/')) {
//       // Only compress API responses that are larger than threshold
//       return compression.filter(req, res);
//     }
//     return false; // Skip compression for other routes
//   }
// }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/api/connection-pool/status';
  }
});
app.use(limiter);

// API-specific rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 API requests per minute
  message: 'API rate limit exceeded, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// 🚀 ADVANCED PERFORMANCE MIDDLEWARE
// ETags for better browser caching
// ETags for browser caching - RE-ENABLED WITH SAFE SETTINGS
app.use(smartETagMiddleware);
app.use(conditionalRequestMiddleware);

// Request deduplication
app.use(smartDeduplicationMiddleware);

// Request queue for high-load scenarios
app.use(requestQueueMiddleware({ maxConcurrentRequests: 100 }));

// Database query monitoring - RE-ENABLED WITH SAFE SETTINGS
app.use(queryMonitorMiddleware({ slowQueryThreshold: 100, logSlowQueries: true }));

// Performance monitoring
app.use(performanceMonitorMiddleware);

// JSON optimization - RE-ENABLED WITH SAFE SETTINGS
app.use(smartJSONOptimization);
app.use(responseSizeMiddleware);

// 🚀 OPTIMIZED MongoDB Connection Pooling Configuration
const mongooseOptions = {
  dbName: 'cpl_13',
  useNewUrlParser: true,
  useUnifiedTopology: true,
  
  // ⚡ CONNECTION POOLING - Core Performance Settings
  maxPoolSize: 20,        // Increased from 10 - Handle more concurrent users
  minPoolSize: 8,         // Increased from 5 - Keep more connections ready
  maxIdleTimeMS: 60000,   // Increased from 30s - Keep connections alive longer
  maxConnecting: 5,       // Allow 5 simultaneous connection attempts
  
  // 🕐 TIMEOUT SETTINGS - Optimized for Performance
  serverSelectionTimeoutMS: 15000,  // Reduced from 30s - Faster failover
  socketTimeoutMS: 30000,           // Reduced from 45s - Faster response
  connectTimeoutMS: 15000,          // Reduced from 30s - Faster connection
  
  // 🔄 RETRY & STABILITY
  retryWrites: true,
  retryReads: true,
  heartbeatFrequencyMS: 5000,       // Increased from 10s - More frequent health checks
  
  // 📊 PERFORMANCE OPTIMIZATIONS
  compressors: ['zlib'],
  zlibCompressionLevel: 6,
  directConnection: false,          // Use replica set for better performance
  
  // 🛡️ CONNECTION MONITORING
  monitorCommands: true,            // Enable command monitoring for debugging
  maxStalenessSeconds: 90,         // Read from secondary if primary is stale
  
  // ⚙️ ADVANCED SETTINGS
  readPreference: 'primaryPreferred', // Read from primary, fallback to secondary
  readConcern: { level: 'local' },    // Fastest read concern
  writeConcern: { w: 1, j: true },    // Acknowledge writes, journaled
};

mongoose.connect(process.env.MONGO_URI, mongooseOptions)
  .then(() => {
    console.log('✅ MongoDB Connected Successfully');
    console.log('📊 Connection State:', mongoose.connection.readyState);
    console.log('🏠 Host:', mongoose.connection.host);
    console.log('🗄️ Database:', mongoose.connection.name);
    console.log('⚡ Pool Size:', mongoose.connection.db?.s?.topology?.s?.pool?.totalConnectionCount || 'N/A');
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.error('🔧 Connection Options:', mongooseOptions);
  });

// 📊 CONNECTION MONITORING & METRICS
let connectionStats = {
  connected: 0,
  disconnected: 0,
  errors: 0,
  queries: 0,
  startTime: Date.now()
};

mongoose.connection.on('connected', () => {
  connectionStats.connected++;
  console.log('🟢 Mongoose connected to MongoDB');
  console.log('📈 Connection Stats:', connectionStats);
});

mongoose.connection.on('error', (err) => {
  connectionStats.errors++;
  console.error('🔴 Mongoose connection error:', err.message);
  console.log('📈 Connection Stats:', connectionStats);
});

mongoose.connection.on('disconnected', () => {
  connectionStats.disconnected++;
  console.log('🟡 Mongoose disconnected from MongoDB');
  console.log('📈 Connection Stats:', connectionStats);
});

// 🔍 QUERY MONITORING
mongoose.connection.on('commandStarted', (event) => {
  connectionStats.queries++;
  if (process.env.NODE_ENV === 'development') {
    console.log(`🔍 Query: ${event.commandName} - ${event.databaseName}.${event.command.collection || 'unknown'}`);
  }
});

mongoose.connection.on('commandSucceeded', (event) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`✅ Query Success: ${event.commandName} - ${event.duration}ms`);
  }
});

mongoose.connection.on('commandFailed', (event) => {
  console.error(`❌ Query Failed: ${event.commandName} - ${event.failure.message}`);
});

// 📊 CONNECTION POOL MONITORING
setInterval(() => {
  const pool = mongoose.connection.db?.s?.topology?.s?.pool;
  if (pool) {
    console.log('🏊 Connection Pool Status:', {
      totalConnections: pool.totalConnectionCount,
      availableConnections: pool.availableConnectionCount,
      checkedOutConnections: pool.checkedOutConnections,
      waitQueueLength: pool.waitQueueLength
    });
  }
}, 30000); // Every 30 seconds

// Handle application termination
process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed through app termination');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error closing MongoDB connection:', err);
    process.exit(1);
  }
});
app.use('/uploads', express.static('uploads'));
app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/api/player', playerRoutes); // This sets the base route for players
app.use('/api/users', userRoutes); // Mount the route
app.use('/api/fixtures', fixtureRoutes);
app.use('/api', playerRoutes);
app.use('/api/bids', bidRoutes); // Mount bid routes
app.use('/api/player-stats', playerStatsRoutes);
// ...
app.use('/api/notifications', notificationRoutes);
app.use('/api/releases', releaseRoutes);
app.use('/api/picks', pickRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/live-scores', liveScoreRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/post-likes', postLikeRoutes);
app.use('/api/playoff-fixtures', playoffFixtureRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/indexes', indexRoutes);
app.use('/api/connection-pool', connectionPoolRoutes);

// 🚀 CACHE MANAGEMENT API
// Cache statistics endpoint
app.get('/api/cache/stats', (req, res) => {
  try {
    const stats = getCacheStats();
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

// Cache invalidation endpoints
app.post('/api/cache/invalidate/user/:userId', (req, res) => {
  try {
    invalidateCache.user(req.params.userId);
    res.json({
      success: true,
      message: `Cache invalidated for user ${req.params.userId}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/cache/invalidate/players', (req, res) => {
  try {
    invalidateCache.players();
    res.json({
      success: true,
      message: 'Players cache invalidated'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/cache/invalidate/fixtures', (req, res) => {
  try {
    invalidateCache.fixtures();
    res.json({
      success: true,
      message: 'Fixtures cache invalidated'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/cache/invalidate/all', (req, res) => {
  try {
    invalidateCache.all();
    res.json({
      success: true,
      message: 'All cache invalidated'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Performance monitoring endpoints
app.get('/api/performance/stats', (req, res) => {
  try {
    const queryStats = getQueryStats();
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    res.json({
      success: true,
      data: {
        queries: queryStats,
        memory: {
          rss: Math.round(memUsage.rss / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          external: Math.round(memUsage.external / 1024 / 1024)
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system
        },
        uptime: process.uptime(),
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

// System diagnostics endpoint
app.get('/api/performance/diagnostics', (req, res) => {
  try {
    const queryStats = getQueryStats();
    const memUsage = process.memoryUsage();
    
    const diagnostics = {
      performance: {
        averageQueryTime: Math.round(queryStats.averageTime),
        slowQueries: queryStats.slowQueries,
        totalQueries: queryStats.totalQueries,
        errorRate: queryStats.errors / Math.max(queryStats.totalQueries, 1) * 100
      },
      memory: {
        usage: Math.round(memUsage.heapUsed / 1024 / 1024),
        total: Math.round(memUsage.heapTotal / 1024 / 1024),
        usagePercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
      },
      recommendations: []
    };
    
    // Add recommendations
    if (queryStats.averageTime > 50) {
      diagnostics.recommendations.push('Consider adding more database indexes');
    }
    
    if (queryStats.slowQueries > queryStats.totalQueries * 0.1) {
      diagnostics.recommendations.push('High number of slow queries - review query patterns');
    }
    
    if (memUsage.heapUsed / memUsage.heapTotal > 0.8) {
      diagnostics.recommendations.push('High memory usage - consider increasing server memory');
    }
    
    res.json({
      success: true,
      data: diagnostics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('place_bid', (data) => {
    // Handle real-time bid logic here
    io.emit('bid_updated', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

// register cron jobs
// require('./scheduler');
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
