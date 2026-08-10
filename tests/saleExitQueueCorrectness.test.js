const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bidRoutesSrc = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'bidRoutes.js'),
  'utf8'
);
const bidQueueSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'bidQueueService.js'),
  'utf8'
);
const bidPlacementSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'bidPlacement.js'),
  'utf8'
);

test('HTTP exit paths set lastExitAt before save (overnight auto-sell gate)', () => {
  // Both admin and user branches in POST /:playerId/exit must stamp lastExitAt.
  const exitHandlerStart = bidRoutesSrc.indexOf('router.post("/:playerId/exit"');
  const exitHandlerEnd = bidRoutesSrc.indexOf('router.post("/bid/sold"');
  assert.ok(exitHandlerStart >= 0 && exitHandlerEnd > exitHandlerStart);
  const exitHandler = bidRoutesSrc.slice(exitHandlerStart, exitHandlerEnd);
  const stamps = exitHandler.match(/player\.lastExitAt\s*=\s*new Date\(\)/g) || [];
  assert.equal(
    stamps.length,
    2,
    'admin and user HTTP exit branches must each set lastExitAt'
  );
  assert.match(exitHandler, /player\.lastExitBy\s*=\s*'system'/);
  assert.match(exitHandler, /player\.lastExitBy\s*=\s*'user'/);
});

test('sellPlayer validates winner (incl. inactive) before sold/UserPlayer writes', () => {
  const fnStart = bidRoutesSrc.indexOf('async function sellPlayer');
  const fnEnd = bidRoutesSrc.indexOf("router.post('/players/:playerId?/soldcrone'");
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const fn = bidRoutesSrc.slice(fnStart, fnEnd);

  const validateIdx = fn.indexOf('includeInactive');
  const markSoldIdx = fn.indexOf('isSold: true');
  const createUpIdx = fn.indexOf('new UserPlayer');
  const deactivateIdx = fn.indexOf('Bid.updateMany');

  assert.ok(validateIdx >= 0, 'must load winner with includeInactive');
  assert.ok(markSoldIdx > validateIdx, 'winner validation must precede marking sold');
  assert.ok(createUpIdx > validateIdx, 'winner validation must precede UserPlayer create');
  assert.ok(
    deactivateIdx > markSoldIdx,
    'bid deactivation must not run before the atomic sold mark'
  );
  assert.match(fn, /Winning bidder is deactivated/);
  assert.match(fn, /Insufficient purse balance for the winning bidder/);
  assert.match(fn, /\.select\('_id currentBids purse'\)/);
});

test('queue promotion drops unavailable head instead of null-deref / stalling', () => {
  assert.match(bidQueueSrc, /async function loadUserForPurse/);
  assert.match(bidQueueSrc, /includeInactive:\s*true/);
  assert.match(bidQueueSrc, /user_unavailable/);
  assert.match(
    bidQueueSrc,
    /const prepared = await preparePromotedUser[\s\S]*?if \(!prepared\)[\s\S]*?removeQueuedEntryById[\s\S]*?continue/
  );
  assert.match(
    bidQueueSrc,
    /async function preparePromotedUser[\s\S]*?return false;[\s\S]*?return true;/
  );
});

test('placeBidCore tolerates io=null after persisting bid/purse state', () => {
  assert.match(
    bidPlacementSrc,
    /Scheduler \/ background promotion may call with io=null/
  );
  assert.match(
    bidPlacementSrc,
    /if \(io\) \{\s*if \(activeBidderSocketIds\.length > 0\)/
  );
  assert.match(bidPlacementSrc, /if \(io\) \{\s*io\.emit\("player_bid_update"/);
});
