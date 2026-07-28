const test = require('node:test');
const assert = require('node:assert/strict');

const requireAdmin = require('../middleware/requireAdmin');
const tradeRoutes = require('../routes/trades');
const releaseRoutes = require('../routes/releases');
const pickRoutes = require('../routes/picks');

function getRouteStack(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
}

function assertAdminGuarded(router, method, path) {
  const stack = getRouteStack(router, method, path);
  assert.equal(stack[0].handle.name, 'authenticateJWT');
  assert.equal(stack[1].handle.name, 'requireAdmin');
}

async function invokeRequireAdmin(user) {
  const req = { authenticatedUser: user };
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

  await requireAdmin(req, res, () => {
    calledNext = true;
  });

  return { statusCode, responseBody, calledNext };
}

async function assertRejectsWithoutJwt(handler) {
  const req = { headers: {}, body: { decision: 'approve', adminUserId: 'spoofed-admin' }, query: {} };
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

  assert.equal(calledNext, false);
  assert.equal(statusCode, 401);
  assert.match(responseBody.message, /authentication required/i);
}

const guardedRoutes = [
  [tradeRoutes, 'get', '/admin/pending'],
  [tradeRoutes, 'get', '/admin/history'],
  [tradeRoutes, 'post', '/admin/:tradeId/decide'],
  [tradeRoutes, 'post', '/admin/unlock-players'],
  [tradeRoutes, 'post', '/admin/unlock-stale'],
  [releaseRoutes, 'get', '/admin/pending'],
  [releaseRoutes, 'get', '/admin/history'],
  [releaseRoutes, 'post', '/admin/:releaseId/decide'],
  [pickRoutes, 'get', '/admin/pending'],
  [pickRoutes, 'get', '/admin/history'],
  [pickRoutes, 'post', '/admin/:pickId/decide'],
];

for (const [router, method, path] of guardedRoutes) {
  test(`${method.toUpperCase()} ${path} requires JWT then admin`, () => {
    assertAdminGuarded(router, method, path);
  });

  test(`${method.toUpperCase()} ${path} rejects unauthenticated spoofed adminUserId`, async () => {
    const authenticate = getRouteStack(router, method, path)[0].handle;
    await assertRejectsWithoutJwt(authenticate);
  });
}

test('requireAdmin rejects missing authenticated user', async () => {
  const result = await invokeRequireAdmin(undefined);
  assert.equal(result.calledNext, false);
  assert.equal(result.statusCode, 401);
});

test('requireAdmin rejects authenticated non-admin', async () => {
  const result = await invokeRequireAdmin({ _id: 'u1', isAdmin: false });
  assert.equal(result.calledNext, false);
  assert.equal(result.statusCode, 403);
  assert.match(result.responseBody.message, /admin access required/i);
});

test('requireAdmin allows authenticated admin', async () => {
  const result = await invokeRequireAdmin({ _id: 'admin1', isAdmin: true });
  assert.equal(result.calledNext, true);
  assert.equal(result.statusCode, 200);
});
