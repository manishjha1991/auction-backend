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

const API_ENDPOINTS = 'https://cpl.in.net';
// const API_ENDPOINTS = 'http://localhost:3000';

const API_BASE = `${API_ENDPOINTS}/api/bids`;
const EXIT_PATH = (id) => `${API_BASE}/${id}/exit-second-highest`;
const EXIT_ALL_PATH = `${API_BASE}/exit-second-highest/all`;
const SELL_PATH = (id) => `${API_BASE}/players/${id}/soldcrone`;
const GET_UNSOLD_PLAYERS = `${API_BASE}/players?filter=unsold`;
const GET_BID_COUNT = (id) => `${API_BASE}/players/${id}/bidders`;
const LOCK_PATH = `${API_BASE}/lock-under-limit/all`;
const SINGLE_BID_PATH = `${API_BASE}/players/singlebid`;
const SETTINGS_PATH = `${API_ENDPOINTS}/api/settings`;

let cachedSettings = null;
let settingsFetchedAt = 0;
const SETTINGS_TTL_MS = 0; // disable caching to reflect toggles immediately

async function getCronSettings(force = false) {
  const now = Date.now();
  if (!force && cachedSettings && now - settingsFetchedAt < SETTINGS_TTL_MS) {
    return cachedSettings;
  }
  try {
    const { data } = await axios.get(SETTINGS_PATH);
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
    const { data } = await axios.get(SETTINGS_PATH);
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
    const res = await axios.get(GET_BID_COUNT(pid));
    count = res.data.count ?? 0;
  } catch (err) {
    console.error(`   ⚠️ bid count error for ${pid}:`, err.message);
    return;
  }

  if (count === 0) {
    console.log(`   → Only one bidder remains, selling player ${pid}`);
    try {
      await axios.post(SELL_PATH(pid), { playerID: pid });
      console.log(`   ✅ Sold player ${pid}`);
    } catch (err) {
      console.error(`   ❌ sell error for ${pid}:`, err.message);
    }
  } else {
    console.log(`   → ${count} bidders found, removing the current second-highest for ${pid}`);
    try {
      await axios.post(EXIT_PATH(pid));
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
    const { data } = await axios.post(SINGLE_BID_PATH);
    const ids = data.resultMain;

    if (!Array.isArray(ids) || ids.length === 0) {
      console.log('   → No single-bid players to finalize.');
      return;
    }

    for (const playerId of ids) {
      try {
        await axios.post(SELL_PATH(playerId));
        console.log(`   ✅ Sold player ${playerId}`);
      } catch (err) {
        console.error(`   ❌ Error selling player ${playerId}:`, err.message);
      }
    }
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
    const { data } = await axios.get(GET_UNSOLD_PLAYERS);
    const players = data.players || [];
    console.log(`  • evaluating ${players.length} unsold player(s)`);

    for (const { _id: pid } of players) {
      await processPlayer(pid);
    }
  } catch (err) {
    console.error('⚠️ fetchUnsoldPlayers error:', err.message);
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
    const { data } = await axios.post(EXIT_ALL_PATH);
    console.log('   → bulk exit response:', data?.message || data);
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
    const { data } = await axios.post(LOCK_PATH);
    console.log('   →', data?.message || 'lock under limit completed');
  } catch (err) {
    console.error('   ❌ lock-under-limit error:', err.message);
  }
}

// Every 10 minutes from 12:30 through 23:50 IST (removes second bidder / sells after a 10-min wait)
cron.schedule('0 30-59/10 12-23 * * *', tenMinuteSingleBidJob, {
  timezone: 'Asia/Kolkata',
});

// 23:30 IST nightly – sell players that never received a counter bid
cron.schedule('0 30 23 * * *', sellingSingleBidSinceStarting, {
  timezone: 'Asia/Kolkata',
});

// Bulk exit every 10 minutes (mutually exclusive with the ten-minute monitor)
cron.schedule('0 */10 * * * *', runBulkExitJob, {
  timezone: 'Asia/Kolkata',
});

// Lock users that violate roster requirements at 22:00 IST daily
cron.schedule('0 0 22 * * *', lockUnderLimitJob, {
  timezone: 'Asia/Kolkata',
});


console.log('🕒 Auction scheduler running…');