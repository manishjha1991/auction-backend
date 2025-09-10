require('dotenv').config();
const express = require('express');

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
const retainedPlayerRoutes = require('./routes/retainedPlayers');


app.set('io', io);
// 🚀 OPTIMIZED MongoDB Connection Pooling Configuration
const mongooseOptions = {
  dbName: 'cpl_12_auction_ready',
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
app.use('/api/retained-players', retainedPlayerRoutes);


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
require('./scheduler');
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
