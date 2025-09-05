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
const playerRoutes = require('./routes/players');
const userRoutes = require('./routes/user');
const bidRoutes = require('./routes/bidRoutes');
const playerStatsRoutes = require('./routes/playerStats');
const fixtureRoutes = require('./routes/fixture');
const notificationRoutes = require('./routes/notifications');
const releaseRoutes = require('./routes/releases');
const pickRoutes = require('./routes/picks');
const newsRoutes = require('./routes/news');
const settingsRoutes = require('./routes/settings');
const tradeRoutes = require('./routes/trades');
const liveScoreRoutes = require('./routes/livescores');
const commentRoutes = require('./routes/comments');
const postLikeRoutes = require('./routes/postLikes');
const playoffFixtureRoutes = require('./routes/playoffFixtures');
const scheduleRoutes = require('./routes/schedules');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('io', io);

// 🚀 SPEED OPTIMIZATIONS (No Dashboard APIs)
// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Response compression for speed
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Rate limiting for protection
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // More restrictive for API routes
  message: 'Too many API requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use('/api/', apiLimiter);

// Basic middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/users', userRoutes);
app.use('/api/bids', bidRoutes);
app.use('/api/player-stats', playerStatsRoutes);
app.use('/api/fixtures', fixtureRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/releases', releaseRoutes);
app.use('/api/picks', pickRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/livescores', liveScoreRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/post-likes', postLikeRoutes);
app.use('/api/playoff-fixtures', playoffFixtureRoutes);
app.use('/api/schedules', scheduleRoutes);

// 🚀 OPTIMIZED MongoDB Connection
const mongooseOptions = {
  dbName: 'cpl_12',
  useNewUrlParser: true,
  useUnifiedTopology: true,
  
  // Connection Pooling for Speed
  maxPoolSize: 20,
  minPoolSize: 8,
  maxIdleTimeMS: 60000,
  maxConnecting: 5,
  
  // Timeout Settings
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 30000,
  connectTimeoutMS: 15000,
  heartbeatFrequencyMS: 5000,
  
  // Performance Settings
  directConnection: false,
  monitorCommands: true,
  maxStalenessSeconds: 90,
  readPreference: 'primaryPreferred',
  readConcern: { level: 'local' },
  writeConcern: { w: 1, j: true }
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/auction', mongooseOptions);

mongoose.connection.on('connected', () => {
  console.log('🟢 Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('🔌 Mongoose disconnected from MongoDB');
});

// Simple health check (no performance stats)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});