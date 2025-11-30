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
const { 
  runBulkExitAll,
  getSingleBidPlayers,
  getUnsoldPlayers,
  getBidderCount,
  sellPlayer,
  exitSecondHighestForPlayerSingle,
  lockUnderLimitAll
} = require('./routes/bidRoutes');

const API_ENDPOINTS = process.env.SCHEDULER_API || 'https://cpl.in.net';

// Settings endpoint still needs HTTP call (it's in a different route file)
const SETTINGS_PATH = `${API_ENDPOINTS}/api/settings`;

let cachedSettings = null;
let settingsFetchedAt = 0;
const SETTINGS_TTL_MS = 0; // disable caching to reflect toggles immediately

const DEFAULT_BATCH_SIZE = parseInt(process.env.SCHEDULER_BATCH_SIZE, 10) || 5;
const DEFAULT_BATCH_DELAY_MS = parseInt(process.env.SCHEDULER_BATCH_DELAY_MS, 10) || 400;
const DEFAULT_ITEM_DELAY_MS = parseInt(process.env.SCHEDULER_ITEM_DELAY_MS, 10) || 100;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function schedulerRequest(method, url, data) {
  const timeout = parseInt(process.env.SCHEDULER_TIMEOUT_MS, 10) || 300000; // 5 minutes default for bulk operations
  try {
    if (method === 'get') {
      return await axios.get(url, { timeout });
    }
    return await axios.post(url, data, { timeout });
  } catch (err) {
    console.error(`⚠️ Scheduler request failed (${url}):`, err.message);
    throw err;
  }
}

async function runInBatches(items, batchSize, handler, pauseMs = DEFAULT_BATCH_DELAY_MS, perItemDelay = DEFAULT_ITEM_DELAY_MS) {
  if (!Array.isArray(items) || items.length === 0) return;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    for (const item of batch) {
      await handler(item);
      if (perItemDelay > 0) {
        await delay(perItemDelay);
      }
    }
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
    // If fetch fails, use cached settings if available, otherwise empty object
    if (!cachedSettings) {
      cachedSettings = {};
      console.error('   ⚠️ No cached settings available, using defaults');
    } else {
      console.error('   ℹ️ Using cached settings due to fetch failure');
    }
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
    const result = await getBidderCount(pid);
    count = result.count ?? 0;
  } catch (err) {
    console.error(`   ⚠️ bid count error for ${pid}:`, err.message);
    return;
  }

  if (count === 0) {
    console.log(`   → Only one bidder remains, selling player ${pid}`);
    try {
      const result = await sellPlayer(pid, null);
      if (result.status === 'success') {
        console.log(`   ✅ Sold player ${pid}`);
      } else {
        console.error(`   ❌ sell error for ${pid}:`, result.message);
      }
    } catch (err) {
      console.error(`   ❌ sell error for ${pid}:`, err.message);
    }
    } else {
    console.log(`   → ${count} bidders found, removing the current second-highest for ${pid}`);
    try {
      const result = await exitSecondHighestForPlayerSingle(pid, null);
      console.log(`   ↪️ Removed second-highest bidder for ${pid}:`, result.message || 'processed');
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
    const result = await getSingleBidPlayers();
    const ids = result.resultMain;

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
          const result = await sellPlayer(playerId, null);
          if (result.status === 'success') {
            console.log(`   ✅ Sold player ${playerId}`);
          } else {
            console.error(`   ❌ Error selling player ${playerId}:`, result.message);
          }
        } catch (err) {
          console.error(`   ❌ Error selling player ${playerId}:`, err.message);
        }
      }
    );
  } catch (err) {
    console.error('   ❌ Error in sellingSingleBidSinceStarting:', err.message);
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
    const result = await getUnsoldPlayers();
    const players = result.players || [];
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

// This function is no longer needed - using exitSecondHighestForPlayerSingle directly

async function runBulkExitJob() {
  try {
    const settings = await getCronSettings();
    
    // Log current settings for debugging
    console.log(`   📊 Settings: cronBulkExitEnabled=${settings.cronBulkExitEnabled}, cronSingleBidEnabled=${settings.cronSingleBidEnabled}`);
    
    // Check if explicitly disabled
    if (settings.cronBulkExitEnabled === false) {
      console.log('⏸️ Bulk exit cron disabled via admin settings.');
      return;
    }
    
    // Check if single-bid monitor is enabled (mutually exclusive)
    if (settings.cronSingleBidEnabled === true) {
      console.log('⏸️ Bulk exit cron paused because the 10-minute monitor is active.');
      return;
    }

    // If cronBulkExitEnabled is undefined/null, default to enabled (backward compatibility)
    if (settings.cronBulkExitEnabled === undefined || settings.cronBulkExitEnabled === null) {
      console.log('   ℹ️ cronBulkExitEnabled not set, defaulting to enabled');
    }

    console.log(`⏱️ [${new Date().toISOString()}] Running bulk exit-second-highest job`);
    // Call the function directly instead of making HTTP request
    const result = await runBulkExitAll(null); // Pass null for io since we're in scheduler context
    console.log('   → bulk exit response:', result?.message || 'completed');
    console.log(`   → processed ${result?.details?.length || 0} user-player combinations`);
  } catch (err) {
    console.error('   ❌ bulk exit error:', err.message);
    console.error('   Stack:', err.stack);
  }
}

async function lockUnderLimitJob() {
  if (!(await isCronEnabled('cronLockEnabled'))) {
    console.log('⏸️ Lock-under-limit cron disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running lock-under-limit job`);
  try {
    const result = await lockUnderLimitAll();
    console.log('   →', result?.message || 'lock under limit completed');
  } catch (err) {
    console.error('   ❌ lock-under-limit error:', err.message);
  }
}

// Run once at 23:31 IST (after 11:30 PM), then every 15 minutes continuously
// Pattern: '31,46 23 * * *' runs at 23:31 and 23:46, then '1,16,31,46 0-23 * * *' runs every 15 min in all hours
// Run at 12:01 AM IST, then every 15 minutes continuously
// Schedule: 00:01, 00:16, 00:31, 00:46, 01:01, 01:16, ... (every 15 minutes)
cron.schedule('1,16,31,46 * * * *', tenMinuteSingleBidJob, {
  timezone: 'Asia/Kolkata',
});

// 23:30 IST nightly – sell players that never received a counter bid
cron.schedule('0 01 23 * * *', sellingSingleBidSinceStarting, {
  timezone: 'Asia/Kolkata',
});

// Bulk exit every 10 minutes (mutually exclusive with the ten-minute monitor)
// Schedule: runs at 0 seconds of every 10th minute (00:00, 00:10, 00:20, 00:30, 00:40, 00:50, 01:00, etc.)
cron.schedule('0 */10 * * * *', () => {
  console.log(`⏰ [${new Date().toISOString()}] Bulk exit cron triggered (every 10 minutes)`);
  runBulkExitJob();
}, {
  timezone: 'Asia/Kolkata',
});

// Lock users that violate roster requirements at 22:30 IST (10:30 PM) daily
cron.schedule('30 22 * * *', lockUnderLimitJob, {
  timezone: 'Asia/Kolkata',
});


console.log('🕒 Auction scheduler running…');