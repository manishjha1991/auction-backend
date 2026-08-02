const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const requireAdmin = require('../middleware/requireAdmin');
const authenticateJWT = require('../middleware/authJWT');
const retainedPlayerRoutes = require('../routes/retainedPlayers');

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

const adminMutationPaths = [
  ['post', '/fix-base-prices'],
  ['post', '/release-all-others'],
  ['post', '/approve-withdrawal/:retainedPlayerId'],
  ['post', '/lock-retention'],
  ['delete', '/:retainedPlayerId'],
  ['post', '/release-team-players'],
  ['post', '/migrate-users'],
  ['post', '/test-user-update'],
  ['post', '/reset-all-players-released'],
];

const userMutationPaths = [
  ['post', '/retain'],
  ['post', '/undo/:retainedPlayerId'],
  ['post', '/withdraw/:retainedPlayerId'],
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

test('destructive retained-player admin routes require JWT admin middleware', () => {
  for (const [method, path] of adminMutationPaths) {
    const names = handlerNames(retainedPlayerRoutes, method, path);
    assert.ok(
      names.includes('authenticateJWT'),
      `${method.toUpperCase()} ${path} must use authenticateJWT`
    );
    assert.ok(
      names.includes('requireAdmin'),
      `${method.toUpperCase()} ${path} must use requireAdmin`
    );
  }
});

test('retain/undo/withdraw require JWT and bind actor to authenticated user', () => {
  for (const [method, path] of userMutationPaths) {
    const names = handlerNames(retainedPlayerRoutes, method, path);
    assert.ok(
      names.includes('authenticateJWT'),
      `${method.toUpperCase()} ${path} must use authenticateJWT`
    );

    const handler = getRouteStack(retainedPlayerRoutes, method, path).at(-1).handle;
    const source = handler.toString();
    assert.match(source, /req\.authenticatedUser\._id/);
    assert.equal(
      /const\s*\{\s*userId/.test(source),
      false,
      `${method.toUpperCase()} ${path} must not trust body userId`
    );
  }
});

test('unauthenticated callers cannot reach release-all-others or fix-base-prices', async () => {
  for (const path of ['/release-all-others', '/fix-base-prices', '/release-team-players']) {
    const stack = getRouteStack(retainedPlayerRoutes, 'post', path);
    const authHandler = stack[0].handle;
    const result = await invoke(authHandler, {
      headers: {},
      body: { adminUserId: 'spoofed-admin', teamId: 'team-1' },
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 401);
  }
});

test('forged JWT without matching server session cannot authorize release-all-others', async () => {
  const stack = getRouteStack(retainedPlayerRoutes, 'post', '/release-all-others');
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
      body: { adminUserId: '507f1f77bcf86cd799439011' },
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.responseBody.message, /session/i);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});

test('admin mutation handlers no longer trust body adminUserId', () => {
  for (const [method, path] of adminMutationPaths) {
    const handler = getRouteStack(retainedPlayerRoutes, method, path).at(-1).handle;
    const source = handler.toString();
    assert.equal(
      /User\.findById\(adminUserId\)/.test(source),
      false,
      `${method.toUpperCase()} ${path} must not authorize via body adminUserId`
    );
    assert.equal(
      /const\s*\{\s*adminUserId/.test(source),
      false,
      `${method.toUpperCase()} ${path} must not read adminUserId from body`
    );
  }
});

test('release-all-others uses defined retained-player cleanup IDs', () => {
  const handler = getRouteStack(retainedPlayerRoutes, 'post', '/release-all-others')
    .at(-1)
    .handle.toString();
  assert.match(handler, /cleanupRetainedPlayerIds/);
  assert.equal(/teamCleanupRetainedPlayerIds/.test(handler), false);
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
