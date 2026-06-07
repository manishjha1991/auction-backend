const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.JWT_SECRET = 'security-auth-test-secret';

const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../models/User');
const Player = require('../models/Player');
const playerRoutes = require('../routes/players');
const bidRoutes = require('../routes/bidRoutes');

function tokenFor(userId) {
  return jwt.sign({ id: userId.toString() }, process.env.JWT_SECRET);
}

function mockAuthenticatedUser(user) {
  const originalFindById = User.findById;
  User.findById = (id) => ({
    includeInactive: async () => (id.toString() === user._id.toString() ? user : null),
  });
  return () => {
    User.findById = originalFindById;
  };
}

async function withTestServer(configureApp, run) {
  const app = express();
  configureApp(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('profile picture upload rejects body userId spoofing', async () => {
  const attackerId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const playerId = new mongoose.Types.ObjectId();
  const restoreUser = mockAuthenticatedUser({
    _id: attackerId,
    isAdmin: false,
    boughtPlayers: [],
    activeSessionId: null,
  });
  const originalPlayerFindById = Player.findById;
  let playerSaveCalled = false;

  Player.findById = async () => ({
    _id: playerId,
    profilePicture: 'cricket-player-portraits/old.png',
    save: async () => {
      playerSaveCalled = true;
    },
  });

  try {
    await withTestServer((app) => {
      app.use('/api', playerRoutes);
    }, async (baseUrl) => {
      const form = new FormData();
      form.set('userId', adminId.toString());
      form.set(
        'profilePicture',
        new Blob([Buffer.from('fake image')], { type: 'image/png' }),
        'avatar.png'
      );

      const response = await fetch(`${baseUrl}/api/${playerId}/admin/profile-picture`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenFor(attackerId)}`,
        },
        body: form,
      });

      assert.equal(response.status, 403);
      assert.match((await response.json()).message, /only replace photos/i);
      assert.equal(playerSaveCalled, false);
    });
  } finally {
    Player.findById = originalPlayerFindById;
    restoreUser();
  }
});

test('auction hub rejects non-admin cross-user access', async () => {
  const attackerId = new mongoose.Types.ObjectId();
  const victimId = new mongoose.Types.ObjectId();
  const restoreUser = mockAuthenticatedUser({
    _id: attackerId,
    isAdmin: false,
    activeSessionId: null,
  });

  try {
    await withTestServer((app) => {
      app.use('/api/bids', bidRoutes);
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/bids/my-auction-hub/${victimId}`, {
        headers: {
          Authorization: `Bearer ${tokenFor(attackerId)}`,
        },
      });

      assert.equal(response.status, 403);
      assert.match((await response.json()).message, /own auction hub/i);
    });
  } finally {
    restoreUser();
  }
});
