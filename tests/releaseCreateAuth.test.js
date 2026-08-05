const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const authenticateJWT = require('../middleware/authJWT');
const releaseRoutes = require('../routes/releases');

function getRouteStack(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
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

test('release create and withdraw require JWT middleware', () => {
  assert.ok(handlerNames(releaseRoutes, 'post', '/').includes('authenticateJWT'));
  assert.ok(
    handlerNames(releaseRoutes, 'post', '/:releaseId/withdraw').includes('authenticateJWT')
  );
});

test('unauthenticated callers cannot reach release create or withdraw handlers', async () => {
  for (const path of ['/', '/:releaseId/withdraw']) {
    const stack = getRouteStack(releaseRoutes, 'post', path);
    const authHandler = stack[0].handle;
    const result = await invoke(authHandler, {
      headers: {},
      body: { userId: 'spoofed-victim', playerId: 'p1', byUserId: 'spoofed-victim' },
      query: {},
      params: { releaseId: '507f1f77bcf86cd799439011' },
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 401);
  }
});

test('release create and withdraw bind actor to authenticated user', () => {
  const createHandler = getRouteStack(releaseRoutes, 'post', '/').at(-1).handle.toString();
  assert.match(createHandler, /req\.authenticatedUser\._id/);
  assert.equal(/const\s*\{\s*userId,\s*playerId/.test(createHandler), false);

  const withdrawHandler = getRouteStack(releaseRoutes, 'post', '/:releaseId/withdraw')
    .at(-1)
    .handle.toString();
  assert.match(withdrawHandler, /req\.authenticatedUser\._id/);
  assert.equal(/const\s*\{\s*byUserId/.test(withdrawHandler), false);
});

test('forged JWT without matching server session cannot authorize release create', async () => {
  const stack = getRouteStack(releaseRoutes, 'post', '/');
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
        isAdmin: false,
        activeSessionId: 'real-session',
      });
    },
  });

  try {
    const result = await invoke(authHandler, {
      headers: { authorization: `Bearer ${forged}` },
      body: {
        userId: '507f1f77bcf86cd799439012',
        playerId: '507f1f77bcf86cd799439013',
      },
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
        isAdmin: false,
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
