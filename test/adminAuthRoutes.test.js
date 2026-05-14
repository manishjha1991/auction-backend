const assert = require('node:assert/strict');
const test = require('node:test');

const bidRoutes = require('../routes/bidRoutes');
const pickRoutes = require('../routes/picks');

function middlewareNames(router, method, path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );

  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} to be registered`);
  return layer.route.stack.map((entry) => entry.handle.name);
}

function assertUsesAuth(router, method, path) {
  const names = middlewareNames(router, method, path);
  assert.ok(
    names.includes('authenticateJWT'),
    `Expected ${method.toUpperCase()} ${path} to require JWT auth`
  );
}

function assertUsesAdminAuth(router, method, path) {
  const names = middlewareNames(router, method, path);
  assert.ok(
    names.includes('authenticateJWT'),
    `Expected ${method.toUpperCase()} ${path} to require JWT auth`
  );
  assert.ok(
    names.includes('requireAdmin'),
    `Expected ${method.toUpperCase()} ${path} to require admin auth`
  );
}

test('bid self-service endpoints require an authenticated user', () => {
  assertUsesAuth(bidRoutes, 'post', '/:playerId/exit');
  assertUsesAuth(bidRoutes, 'get', '/my-auction-hub/:userId');
});

test('bid administrative mutation endpoints require admin auth', () => {
  [
    '/bid/sold',
    '/release-player',
    '/:playerId/exit-second-highest',
    '/players/:playerId?/soldcrone',
    '/exit-second-highest/all',
    '/lock-under-limit/all',
  ].forEach((path) => assertUsesAdminAuth(bidRoutes, 'post', path));
});

test('pick administrative endpoints require admin auth', () => {
  assertUsesAdminAuth(pickRoutes, 'get', '/admin/pending');
  assertUsesAdminAuth(pickRoutes, 'post', '/admin/:pickId/decide');
  assertUsesAdminAuth(pickRoutes, 'get', '/admin/history');
});
