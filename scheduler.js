/**
 * Auction Scheduler
 *
 * Business rules:
 * 1. 23:30 IST nightly – sell any player that has only ever received a single bid.
 * 2. Every 15 minutes – remove the second-highest bidder from every player (no auto-sell).
 * 3. 22:00 IST nightly – lock users who are bidding without the minimum required
 *    Sapphire/Emerald/Gold/Silver holdings.
 * 4. Every 10 minutes from 12:30–23:50 IST – if the “single-bid monitor” is enabled
 *    (and the bulk-exit job is disabled) remove the second-highest bidder from each
 *    unsold player and sell the player once only one bidder remains for a full cycle.
 *
 * Admins can toggle each cron in the Admin Control Panel. The ten-minute monitor
 * and the bulk-exit cron are mutually exclusive by design—enabling one pauses the other.
 */

const cron = require('node-cron');
const axios = require('axios');

const API_BASES = [];
if (process.env.SCHEDULER_API) {
  API_BASES.push(process.env.SCHEDULER_API);
}
API_BASES.push('http://127.0.0.1:3000');
if (!API_BASES.includes('https://cpl.in.net')) {
  API_BASES.push('https://cpl.in.net');
}

const EXIT_PATH = (id) => `/api/bids/${id}/exit-second-highest`;
const SELL_PATH = (id) => `/api/bids/players/${id}/soldcrone`;
const GET_UNSOLD_PLAYERS = `/api/bids/players?filter=unsold`;
const GET_BID_COUNT = (id) => `/api/bids/players/${id}/bidders`;
const LOCK_PATH = `/api/bids/lock-under-limit/all`;
const SINGLE_BID_PATH = `/api/bids/players/singlebid`;
const SETTINGS_PATH = `/api/settings`;

let cachedSettings = null;
let settingsFetchedAt = 0;
const SETTINGS_TTL_MS = 0; // disable caching to reflect toggles immediately

const DEFAULT_BATCH_SIZE = parseInt(process.env.SCHEDULER_BATCH_SIZE, 10) || 10;
const DEFAULT_BATCH_DELAY_MS = parseInt(process.env.SCHEDULER_BATCH_DELAY_MS, 10) || 250;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function schedulerRequest(method, path, data) {
  const timeout = parseInt(process.env.SCHEDULER_TIMEOUT_MS, 10) || 45000;
  let lastError;
  for (const base of API_BASES) {
    const url = `${base}${path}`;
    try {
      if (method === 'get') {
        return await axios.get(url, { timeout });
      }
      return await axios.post(url, data, { timeout });
    } catch (err) {
      lastError = err;
      console.error(`⚠️ Scheduler request failed (${url}):`, err.message);
    }
  }
  throw lastError;
}

async function runInBatches(items, batchSize, handler, pauseMs = DEFAULT_BATCH_DELAY_MS) {
  if (!Array.isArray(items) || items.length === 0) return;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map((item) => handler(item)));
    if (pauseMs > 0 && i + batchSize < items.length) {
      await delay(pauseMs);
    }
  }
}

async function getCronSettings(force = false) {
  const now = Date.now();
  if (!force && cachedSettings && now - settingsFetchedAt < SETTINGS_TTL_MS) {
    return cachedSettings;
  }
  try {
    const { data } = await schedulerRequest('get', SETTINGS_PATH);
    cachedSettings = data || {};
    settingsFetchedAt = now;
  } catch (err) {
    console.error('⚠️ Unable to fetch cron settings:', err.message);
    if (!cachedSettings) cachedSettings = {};
  }
  return cachedSettings;
}

async function isCronEnabled(flag) {
  const settings = await getCronSettings();
  return settings[flag] !== false;
}

async function fetchCronSettings() {
  try {
    const { data } = await schedulerRequest('get', SETTINGS_PATH);
    return data || {};
  } catch (err) {
    console.error('⚠️ Unable to fetch cron settings:', err.message);
    return {};
  }
}

async function processPlayer(pid) {
  console.log(`▶️ [${new Date().toISOString()}] Evaluating player ${pid}`);
  let count;
  try {
    const res = await schedulerRequest('get', GET_BID_COUNT(pid));
    count = res.data.count ?? 0;
  } catch (err) {
    console.error(`   ⚠️ bid count error for ${pid}:`, err.message);
    return;
  }

  if (count === 0) {
    console.log(`   → Only one bidder remains, selling player ${pid}`);
    try {
      await schedulerRequest('post', SELL_PATH(pid), { playerID: pid });
      console.log(`   ✅ Sold player ${pid}`);
    } catch (err) {
      console.error(`   ❌ sell error for ${pid}:`, err.message);
    }
  } else {
    console.log(`   → ${count} bidders found, removing the current second-highest for ${pid}`);
    try {
      await schedulerRequest('post', EXIT_PATH(pid));
      console.log(`   ↪️ Removed second-highest bidder for ${pid}`);
    } catch (err) {
      console.error(`   ❌ exit-second-highest error for ${pid}:`, err.message);
    }
  }
}

async function sellingSingleBidSinceStarting() {
  if (!(await isCronEnabled('cronSingleBidFinalizerEnabled'))) {
    console.log('⏸️ 23:30 single-bid finalizer disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running 23:30 single-bid finalizer`);
  try {
    const { data } = await schedulerRequest('post', SINGLE_BID_PATH);
    const ids = data.resultMain;

    if (!Array.isArray(ids) || ids.length === 0) {
      console.log('   → No single-bid players to finalize.');
      return;
    }

    const batchSize = parseInt(process.env.SCHEDULER_SINGLEBID_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      ids,
      batchSize,
      async (playerId) => {
        try {
          await schedulerRequest('post', SELL_PATH(playerId));
          console.log(`   ✅ Sold player ${playerId}`);
        } catch (err) {
          console.error(`   ❌ Error selling player ${playerId}:`, err.message);
        }
      }
    );
  } catch (err) {
    console.error('   ❌ Error in sellingSingleBidSinceStarting:', err.response?.data || err.message);
  }
}

async function tenMinuteSingleBidJob() {
  const settings = await getCronSettings();
  if (settings.cronBulkExitEnabled) {
    console.log('⏸️ Ten-minute single-bid monitor paused because bulk exit is active.');
    return;
  }
  if (settings.cronSingleBidEnabled === false) {
    console.log('⏸️ Ten-minute single-bid monitor disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running ten-minute single-bid monitor`);
  try {
    const { data } = await schedulerRequest('get', GET_UNSOLD_PLAYERS);
    const players = data.players || [];
    console.log(`  • evaluating ${players.length} unsold player(s)`);

    const batchSize = parseInt(process.env.SCHEDULER_MONITOR_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      players,
      batchSize,
      async ({ _id: pid, id }) => {
        await processPlayer(pid || id);
      }
    );
  } catch (err) {
    console.error('⚠️ fetchUnsoldPlayers error:', err.message);
  }
}

async function exitSecondHighestForPlayer(playerId) {
  try {
    const { data } = await schedulerRequest('post', EXIT_PATH(playerId));
    console.log(`      • player ${playerId}:`, data?.message || 'processed');
  } catch (err) {
    console.error(`      ⚠️ player ${playerId} exit error:`, err.message);
  }
}

async function runBulkExitJob() {
   
  const settings = await getCronSettings();
  if (settings.cronSingleBidEnabled) {
    console.log('⏸️ Bulk exit cron paused because the 10-minute monitor is active.');
    return;
  }
  if (settings.cronBulkExitEnabled === false) {
   
    console.log('⏸️ Bulk exit cron disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running bulk exit-second-highest job`);
  try {
    const { data } = await schedulerRequest('get', GET_UNSOLD_PLAYERS);
    const players = data?.players || [];
    console.log(`   → processing ${players.length} unsold player(s) in batches`);

    const batchSize = parseInt(process.env.SCHEDULER_EXIT_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      players,
      batchSize,
      async (p) => exitSecondHighestForPlayer(p._id || p.id)
    );
    console.log('   ✅ bulk exit batch run completed');
  } catch (err) {
    console.error('   ❌ bulk exit error:', err.message);
  }
}

async function lockUnderLimitJob() {
  if (!(await isCronEnabled('cronLockEnabled'))) {
    console.log('⏸️ Lock-under-limit cron disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running lock-under-limit job`);
  try {
    const { data } = await schedulerRequest('post', LOCK_PATH);
    console.log('   →', data?.message || 'lock under limit completed');
  } catch (err) {
    console.error('   ❌ lock-under-limit error:', err.message);
  }
}

// Every 10 minutes from 12:30 through 23:50 IST (removes second bidder / sells after a 10-min wait)
// cron.schedule('0 30-59/10 12-23 * * *', tenMinuteSingleBidJob, {
//   timezone: 'Asia/Kolkata',
// });

// 23:30 IST nightly – sell players that never received a counter bid
// cron.schedule('0 30 23 * * *', sellingSingleBidSinceStarting, {
//   timezone: 'Asia/Kolkata',
// });

// Bulk exit every 10 minutes (mutually exclusive with the ten-minute monitor)
cron.schedule('0 */10 * * * *', runBulkExitJob, {
  timezone: 'Asia/Kolkata',
});

// Lock users that violate roster requirements at 22:00 IST daily
// cron.schedule('0 0 22 * * *', lockUnderLimitJob, {
//   timezone: 'Asia/Kolkata',
// });


console.log('🕒 Auction scheduler running…');