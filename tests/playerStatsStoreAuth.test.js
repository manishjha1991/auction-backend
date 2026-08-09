const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const requireAdmin = require('../middleware/requireAdmin');
const authenticateJWT = require('../middleware/authJWT');
const playerStatsRoutes = require('../routes/playerStats');

function getRouteStack(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
}

function getAllRouteStacks(router, method, path) {
  const layers = router.stack.filter(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layers.length > 0, `${method.toUpperCase()} ${path} must exist`);
  return layers.map((layer) => layer.route.stack);
}

function handlerNames(router, method, path) {
  return getRouteStack(router, method, path).map((layer) => layer.handle.name);
}

async function invoke(handler, req) {
  let statusCode = 200;
  let responseBody;
  let calledNext = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      responseBody = payload;
      return this;
    },
  };

  await handler(req, res, () => {
    calledNext = true;
  });

  return { statusCode, responseBody, calledNext };
}

const protectedStorePaths = [
  [playerStatsRoutes, 'post', '/store'],
  [playerStatsRoutes, 'post', '/bulk-store'],
];

test('requireAdmin blocks missing and non-admin users', async () => {
  const missing = await invoke(requireAdmin, {});
  assert.equal(missing.calledNext, false);
  assert.equal(missing.statusCode, 401);

  const nonAdmin = await invoke(requireAdmin, {
    authenticatedUser: { isAdmin: false },
  });
  assert.equal(nonAdmin.calledNext, false);
  assert.equal(nonAdmin.statusCode, 403);

  const admin = await invoke(requireAdmin, {
    authenticatedUser: { isAdmin: true },
  });
  assert.equal(admin.calledNext, true);
  assert.equal(admin.statusCode, 200);
});

test('player-stats store and bulk-store require JWT admin middleware', () => {
  for (const [router, method, path] of protectedStorePaths) {
    const names = handlerNames(router, method, path);
    assert.ok(
      names.includes('authenticateJWT'),
      `${method.toUpperCase()} ${path} must use authenticateJWT`
    );
    assert.ok(
      names.includes('requireAdmin'),
      `${method.toUpperCase()} ${path} must use requireAdmin`
    );
  }

  // Both registrations of /bulk-store must be guarded.
  for (const stack of getAllRouteStacks(playerStatsRoutes, 'post', '/bulk-store')) {
    const names = stack.map((layer) => layer.handle.name);
    assert.ok(names.includes('authenticateJWT'));
    assert.ok(names.includes('requireAdmin'));
  }
});

test('unauthenticated callers cannot reach store or bulk-store', async () => {
  for (const [router, method, path] of protectedStorePaths) {
    const stack = getRouteStack(router, method, path);
    const authHandler = stack[0].handle;
    const result = await invoke(authHandler, {
      headers: {},
      body: {
        playerId: '507f1f77bcf86cd799439011',
        battingStats: { runs: 9999, balls: 1 },
        isPlayoffScore: true,
        entries: [{ playerId: '507f1f77bcf86cd799439011', battingStats: { runs: 9999 } }],
      },
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 401);
  }
});

test('forged JWT without matching server session cannot authorize store', async () => {
  const stack = getRouteStack(playerStatsRoutes, 'post', '/store');
  const authHandler = stack[0].handle;

  const forged = jwt.sign(
    { id: '507f1f77bcf86cd799439011' },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '1d' }
  );

  const originalFindById = require('../models/User').findById;
  require('../models/User').findById = () => ({
    includeInactive() {
      return Promise.resolve({
        _id: '507f1f77bcf86cd799439011',
        isAdmin: true,
        activeSessionId: 'real-session',
      });
    },
  });

  try {
    const result = await invoke(authHandler, {
      headers: { authorization: `Bearer ${forged}` },
      body: {},
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.responseBody.message, /session/i);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});

test('authenticateJWT rejects tokens that omit sessionId', async () => {
  const forged = jwt.sign(
    { id: '507f1f77bcf86cd799439011' },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '1d' }
  );

  const originalFindById = require('../models/User').findById;
  require('../models/User').findById = () => ({
    includeInactive() {
      return Promise.resolve({
        _id: '507f1f77bcf86cd799439011',
        isAdmin: true,
        activeSessionId: 'real-session',
      });
    },
  });

  try {
    const result = await invoke(authenticateJWT, {
      headers: { authorization: `Bearer ${forged}` },
      body: {},
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});

test('non-admin session-bound JWT is rejected by requireAdmin on store', async () => {
  const stack = getRouteStack(playerStatsRoutes, 'post', '/store');
  assert.equal(stack[1].handle.name, 'requireAdmin');

  const result = await invoke(stack[1].handle, {
    authenticatedUser: { isAdmin: false },
  });
  assert.equal(result.calledNext, false);
  assert.equal(result.statusCode, 403);
});
