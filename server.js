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

app.set('io', io);
mongoose.connect(process.env.MONGO_URI, { dbName: 'cpl_13',useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));
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
