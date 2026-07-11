const assert = require('node:assert/strict');
const test = require('node:test');

function findRoute(router, method, path) {
  return router.stack.find((layer) => (
    layer.route &&
    layer.route.path === path &&
    layer.route.methods[method]
  ));
}

function handlerNames(layer) {
  return layer.route.stack.map((routeLayer) => routeLayer.handle.name);
}

test('personalized auction hub requires JWT before route handler', () => {
  const bidRoutes = require('../routes/bidRoutes');
  const route = findRoute(bidRoutes, 'get', '/my-auction-hub/:userId');

  assert.ok(route, 'expected my auction hub route to be registered');
  assert.equal(handlerNames(route)[0], 'authenticateJWT');
});

test('local profile-picture replacement requires JWT before upload handling', () => {
  const playerRoutes = require('../routes/players');
  const route = findRoute(playerRoutes, 'post', '/:playerId/admin/profile-picture');

  assert.ok(route, 'expected profile-picture route to be registered');
  assert.equal(handlerNames(route)[0], 'authenticateJWT');
});
