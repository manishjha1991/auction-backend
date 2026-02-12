/**
 * Auction Scheduler
 *
 * Business rules:
 * 1. 22:30 IST nightly – sell any player that has only ever received a single bid.
 * 2. 18:00–22:00 IST – every 10 minutes bulk exit second-highest (admin toggle).
 * 3. 22:30–23:20 IST – every 5 minutes remove second-highest bidder only (no auto-sell).
 * 4. 23:30–00:30 IST – every 5 minutes remove second-highest bidder; if no new bid
 *    since last exit for 5 minutes, sell.
 * 5. 00:30–02:00 IST – every 2 minutes, if no new bid since last exit for 2 minutes, sell;
 *    else remove second-highest.
 * 5. Every 15 minutes – remove the second-highest bidder from every player (no auto-sell).
 * 6. 22:00 IST nightly – lock users who are bidding without the minimum required
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
const Player = require('./models/Player');
const { 
  runBulkExitAll,
  getSingleBidPlayers,
  getUnsoldPlayers,
  getBidderCount,
  sellPlayer,
  exitSecondHighestForPlayerSingle,
  lockUnderLimitAll
} = require('./routes/bidRoutes');

// For local dev, set SCHEDULER_API=http://localhost:3000 in .env so settings fetch works
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

async function shouldSellNoNewBidSinceExit(player, windowMs) {
  if (!player?.lastExitAt) return false;
  const lastExitTime = new Date(player.lastExitAt).getTime();
  const lastBidTime = player.lastBidAt ? new Date(player.lastBidAt).getTime() : 0;
  const now = Date.now();
  return lastBidTime <= lastExitTime && now - lastExitTime >= windowMs;
}

async function processCounterBidWindow(pid, windowMs) {
  const player = await Player.findById(pid).lean();
  if (!player || player.isSold) return;
  const result = await getBidderCount(pid);
  const count = result.count ?? 0;

  // count=0: one bidder only (second exited) → sell only if window elapsed
  if (count === 0) {
    if (await shouldSellNoNewBidSinceExit(player, windowMs)) {
      await sellPlayer(pid, null);
    }
    return;
  }

  // count=1: two+ bidders (second hasn't exited) → never sell, only exit second
  await exitSecondHighestForPlayerSingle(pid, null);
}

async function processPostWindow(pid) {
  const player = await Player.findById(pid).lean();
  if (!player || player.isSold) return;
  const result = await getBidderCount(pid);
  const count = result.count ?? 0;
  const windowMs = 2 * 60 * 1000;

  // count=0: one bidder only (second exited) → sell only if window elapsed
  if (count === 0) {
    if (await shouldSellNoNewBidSinceExit(player, windowMs)) {
      await sellPlayer(pid, null);
    }
    return;
  }

  // count=1: two+ bidders (second hasn't exited) → never sell, only exit second
  await exitSecondHighestForPlayerSingle(pid, null);
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

  // Only allow this job to run from 11:30 PM–2:00 AM IST
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const timeBag = {};
  nowParts.forEach((p) => {
    if (p.type !== 'literal') timeBag[p.type] = p.value;
  });
  const hour = Number(timeBag.hour);
  const minute = Number(timeBag.minute);
  const isAfter1130 = hour > 23 || (hour === 23 && minute >= 30);
  const isBefore2 = hour < 2;
  if (!(isAfter1130 || isBefore2)) {
    console.log('⏸️ Ten-minute single-bid monitor skipped (outside 11:30 PM–2:00 AM IST window).');
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

async function counterBidWindowJob(windowMinutes) {
  const settings = await getCronSettings();
  if (settings.cronBulkExitEnabled) {
    console.log('⏸️ Counter-bid window paused because bulk exit is active.');
    return;
  }
  if (settings.cronSingleBidEnabled === false) {
    console.log('⏸️ Counter-bid window disabled via admin settings.');
    return;
  }

  const now = new Date();
  console.log(`⏱️ [${now.toISOString()}] Running ${windowMinutes}-minute counter-bid window`);
  try {
    const result = await getUnsoldPlayers();
    const players = result.players || [];
    const batchSize = parseInt(process.env.SCHEDULER_MONITOR_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      players,
      batchSize,
      async ({ _id: pid, id }) => {
        await processCounterBidWindow(pid || id, windowMinutes * 60 * 1000);
      }
    );
  } catch (err) {
    console.error('⚠️ counterBidWindowJob error:', err.message);
  }
}

async function exitOnlyWindowJob(windowMinutes) {
  const settings = await getCronSettings();
  // Note: cronBulkExitEnabled only affects 18:00–22:00. Exit-only runs 22:30–23:20, so no overlap.
  if (settings.cronSingleBidEnabled === false) {
    console.log('⏸️ Exit-only window disabled via admin settings (cronSingleBidEnabled=false).');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running exit-only window every ${windowMinutes} minutes`);
  try {
    const result = await getUnsoldPlayers();
    const players = result.players || [];
    const batchSize = parseInt(process.env.SCHEDULER_MONITOR_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      players,
      batchSize,
      async ({ _id: pid, id }) => {
        await exitSecondHighestForPlayerSingle(pid || id, null);
      }
    );
  } catch (err) {
    console.error('⚠️ exitOnlyWindowJob error:', err.message);
  }
}

async function postWindowJob() {
  const settings = await getCronSettings();
  if (settings.cronBulkExitEnabled) {
    console.log('⏸️ Post-window job paused because bulk exit is active.');
    return;
  }
  if (settings.cronSingleBidEnabled === false) {
    console.log('⏸️ Post-window job disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running post-window 2-minute cycle`);
  try {
    const result = await getUnsoldPlayers();
    const players = result.players || [];
    const batchSize = parseInt(process.env.SCHEDULER_MONITOR_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      players,
      batchSize,
      async ({ _id: pid, id }) => {
        await processPostWindow(pid || id);
      }
    );
  } catch (err) {
    console.error('⚠️ postWindowJob error:', err.message);
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

// Run at 12:05 AM IST, then every 15 minutes continuously
// Schedule: 00:05, 00:20, 00:35, 00:50, 01:05, 01:20, ... (every 15 minutes)
cron.schedule('5,20,35,50 * * * *', tenMinuteSingleBidJob, {
  timezone: 'Asia/Kolkata',
});

// 22:30 IST nightly – sell players that never received a counter bid
cron.schedule('0 30 22 * * *', sellingSingleBidSinceStarting, {
  timezone: 'Asia/Kolkata',
});

// 22:30–23:20 IST – every 5 minutes exit-only window (no auto-sell), extended till 11:20 PM
cron.schedule('0 30,35,40,45,50,55 22 * * *', () => exitOnlyWindowJob(5), {
  timezone: 'Asia/Kolkata',
});
cron.schedule('0 0,5,10,15,20 23 * * *', () => exitOnlyWindowJob(5), {
  timezone: 'Asia/Kolkata',
});

// 23:30–00:30 IST – every 5 minutes counter-bid window
cron.schedule('0 30-59/5 23 * * *', () => counterBidWindowJob(5), {
  timezone: 'Asia/Kolkata',
});

// 00:00–00:30 IST – every 5 minutes counter-bid window
cron.schedule('0 0-30/5 0 * * *', () => counterBidWindowJob(5), {
  timezone: 'Asia/Kolkata',
});

// 00:30–00:59 IST – every 2 minutes post-window cycle
cron.schedule('0 30-59/2 0 * * *', () => postWindowJob(), {
  timezone: 'Asia/Kolkata',
});

// 01:00–01:59 IST – every 2 minutes post-window cycle
cron.schedule('0 */2 1 * * *', () => postWindowJob(), {
  timezone: 'Asia/Kolkata',
});

// Bulk exit every 10 minutes from 18:00–21:59 IST (mutually exclusive with the ten-minute monitor)
cron.schedule('0 */10 18-21 * * *', () => {
  console.log(`⏰ [${new Date().toISOString()}] Bulk exit cron triggered (18:00–22:00 window)`);
  runBulkExitJob();
}, {
  timezone: 'Asia/Kolkata',
});

// Lock users that violate roster requirements at 22:00 IST (10:00 PM) daily
cron.schedule('0 22 * * *', lockUnderLimitJob, {
  timezone: 'Asia/Kolkata',
});


console.log('🕒 Auction scheduler running…');