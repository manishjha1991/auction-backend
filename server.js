require('dotenv').config();
const express = require('express');

const mongoose = require('mongoose');

const cors = require('cors');
const compression = require('compression');
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
const retainedPlayerRoutes = require('./routes/retainedPlayers');
const tournamentRoutes = require('./routes/tournaments');
const matchResultsRoutes = require('./routes/matchResults');
const adminToolsRoutes = require('./routes/adminTools');
const monitoringRoutes = require('./routes/monitoring');
require('./scheduler');

// Allow Express to trust proxy headers (needed to read real client IPs)
app.set('trust proxy', true);

app.set('io', io);
// 🚀 OPTIMIZED MongoDB Connection Pooling Configuration
const mongooseOptions = {
  dbName: 'cpl_19',
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

app.use('/uploads', express.static('uploads'));

// 🚀 PERFORMANCE: Add compression middleware (reduces response size by 60-80%)
app.use(compression());

// Enhanced CORS configuration for geographic access
app.use(cors({
  origin: '*', // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'user-id'],
  credentials: false
}));

// Add request logging middleware
const { getClientIp } = require('./utils/network');

app.use((req, res, next) => {
  const clientIP = getClientIp(req);
  const userAgent = req.get('User-Agent') || 'Unknown';
  const country = req.get('CF-IPCountry') || req.get('X-Country-Code') || 'Unknown';
  
  console.log(`🌍 Request from ${country} (IP: ${clientIP}): ${req.method} ${req.path}`);
  console.log(`📱 User-Agent: ${userAgent}`);
  
  next();
});

app.use(express.json());

// 🚀 PERFORMANCE: Add performance monitoring middleware (only in development)
if (process.env.NODE_ENV !== 'production') {
  const { performanceMonitor } = require('./utils/performanceMonitor');
  app.use(performanceMonitor);
}

// Test endpoint to check if requests are reaching the server
app.get('/api/test', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  const country = req.get('CF-IPCountry') || req.get('X-Country-Code') || 'Unknown';
  const userAgent = req.get('User-Agent') || 'Unknown';
  
  console.log(`🧪 TEST ENDPOINT HIT from ${country} (IP: ${clientIP})`);
  console.log(`📱 User-Agent: ${userAgent}`);
  
  res.json({
    message: 'Server is reachable!',
    timestamp: new Date().toISOString(),
    clientIP,
    country,
    userAgent: userAgent.substring(0, 100) // Truncate for readability
  });
});

app.use('/api/auth', authRoutes);
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
app.use('/api/retained-players', retainedPlayerRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/match-results', matchResultsRoutes);
app.use('/api/admin-tools', adminToolsRoutes);
app.use('/api/monitoring', monitoringRoutes);


// 🚀 NOTIFICATION: Socket user mapping for targeted notifications
const { registerUserSocket, unregisterSocket } = require('./utils/socketUserMap');

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // When user identifies themselves (sends userId)
  socket.on('user_identify', (data) => {
    const userId = data?.userId || data?.user_id || data?.id;
    if (userId) {
      registerUserSocket(userId, socket.id);
      // Store userId in socket session for later use
      socket.userId = userId;
      console.log(`✅ User ${userId} identified with socket ${socket.id}`);
    }
  });

  socket.on('place_bid', (data) => {
    // Handle real-time bid logic here
    io.emit('bid_updated', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Clean up socket mapping
    unregisterSocket(socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
