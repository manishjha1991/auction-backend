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

app.set('io', io);
// Enhanced MongoDB connection with timeout and retry settings
const mongooseOptions = {
  dbName: 'cpl_12',
  useNewUrlParser: true,
  useUnifiedTopology: true,
  // Connection timeout settings
  serverSelectionTimeoutMS: 30000, // 30 seconds
  socketTimeoutMS: 45000, // 45 seconds
  connectTimeoutMS: 30000, // 30 seconds
  // Retry settings
  maxPoolSize: 10, // Maintain up to 10 socket connections
  minPoolSize: 5, // Maintain a minimum of 5 socket connections
  maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
  // Heartbeat settings
  heartbeatFrequencyMS: 10000, // Send a ping every 10 seconds
  // Additional stability settings
  retryWrites: true,
  retryReads: true,
  // Compression
  compressors: ['zlib'],
  zlibCompressionLevel: 6
};

mongoose.connect(process.env.MONGO_URI, mongooseOptions)
  .then(() => {
    console.log('✅ MongoDB Connected Successfully');
    console.log('📊 Connection State:', mongoose.connection.readyState);
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Error:', err.message);
    console.error('🔧 Connection Options:', mongooseOptions);
  });

// Handle connection events
mongoose.connection.on('connected', () => {
  console.log('🟢 Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('🔴 Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('🟡 Mongoose disconnected from MongoDB');
});

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
