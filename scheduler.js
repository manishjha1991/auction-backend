/**
 * Auction Scheduler — all times IST.
 *
 * 9:00 PM     Auto start: categories ON + bulk ON
 * 9:00–10:45  Bulk exit every 10 min (NO sell)
 * 10:45 PM    Bulk OFF
 * 11:00 PM    Lock under-limit (once)
 * 11:30 PM    Sell players with no counter bid since start
 * 11:30–12:30 Bulk exit every 10 min (NO sell)
 * 12:30 AM    Bulk OFF
 * Pre-sell freeze + solo sell:
 *   Cron expression strings below are the source of truth.
 *   Freeze = last full minute before the solo-sell cron (parsed automatically).
 *   Night "minutes from start" uses the auction-start cron hour/minute (not a hardcoded 9 PM).
 */

const cron = require('node-cron');
const Player = require('./models/Player');
const AppSettings = require('./models/AppSettings');
const { 
  runBulkExitAll,
  getSingleBidPlayers,
  getUnsoldPlayers,
  getBidderCount,
  sellPlayer,
  exitSecondHighestForPlayerSingle,
  lockUnderLimitAll
} = require('./routes/bidRoutes');
const {
  getArmedCronFlags,
  registerNightTimingFromCrons,
  getSoloSellClockIst,
  addMinutesToClock,
} = require('./utils/auctionNightPhase');

// Settings are read directly from MongoDB so Auto Mode toggles apply immediately
// (no HTTP round-trip to a remote host that may have different AppSettings).
let cachedSettings = null;
let settingsFetchedAt = 0;
const SETTINGS_TTL_MS = 0; // disable caching to reflect toggles immediately

const DEFAULT_BATCH_SIZE = parseInt(process.env.SCHEDULER_BATCH_SIZE, 10) || 5;
const DEFAULT_BATCH_DELAY_MS = parseInt(process.env.SCHEDULER_BATCH_DELAY_MS, 10) || 400;
const DEFAULT_ITEM_DELAY_MS = parseInt(process.env.SCHEDULER_ITEM_DELAY_MS, 10) || 100;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getCronSettings(force = false) {
  const now = Date.now();
  if (!force && cachedSettings && now - settingsFetchedAt < SETTINGS_TTL_MS) {
    return cachedSettings;
  }
  try {
    const doc = await AppSettings.findOne().lean();
    cachedSettings = doc || {};
    settingsFetchedAt = now;
  } catch (err) {
    console.error('⚠️ Unable to load cron settings from AppSettings:', err.message);
    if (!cachedSettings) {
      cachedSettings = {};
      console.error('   ⚠️ No cached settings available, using defaults');
    } else {
      console.error('   ℹ️ Using cached settings due to DB read failure');
    }
  }
  return cachedSettings;
}

async function isCronEnabled(flag) {
  const settings = await getCronSettings();
  return settings[flag] !== false;
}

function invalidateSettingsCache() {
  cachedSettings = null;
  settingsFetchedAt = 0;
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
  if (!player) return false;
  if (!player.lastExitAt) {
    // Fallback: player can be in a single-bidder state without a recorded exit
    // (e.g., no second bidder ever formed). In that case, use lastBidAt.
    const lastBidTime = player.lastBidAt ? new Date(player.lastBidAt).getTime() : 0;
    const now = Date.now();
    return !!lastBidTime && now - lastBidTime >= windowMs;
  }
  const lastExitTime = new Date(player.lastExitAt).getTime();
  const lastBidTime = player.lastBidAt ? new Date(player.lastBidAt).getTime() : 0;
  const now = Date.now();
  return lastBidTime <= lastExitTime && now - lastExitTime >= windowMs;
}

/**
 * 12:50 AM–4:00 AM IST: Every 5 min
 * - 2 active bidders → NEVER sell, only exit second-highest
 * - 1 active bidder (second exited) + lastExit >= 2 min + no new bid → sell
 * (Must NOT run at 12:45 — that minute is sell-only for already-solo lots.)
 */
async function processCounterBidWindow(pid, windowMs) {
  const player = await Player.findById(pid).lean();
  if (!player || player.isSold) return;
  const result = await getBidderCount(pid);
  const count = result.count ?? 0;

  if (count !== 0) {
    // count=1 means 0 bids OR 2+ unique bidders. NEVER sell.
    if (count === 1) {
      await exitSecondHighestForPlayerSingle(pid, null);
    }
    return;
  }

  // count=0: exactly one unique active bidder → sell only if wait elapsed since last exit
  if (await shouldSellNoNewBidSinceExit(player, windowMs)) {
    await sellPlayer(pid, null);
  } else {
    // Window not elapsed yet – do nothing (already 1 bidder, can't exit)
  }
}

/**
 * 12:16–1:00 AM IST: Every 2 min
 * Same logic as counter-bid window but with 2 min instead of 5 min:
 * - 2 active bidders → NEVER sell, only exit second-highest
 * - 1 active bidder + lastExit >= 2 min + no new bid → sell
 */
async function processPostWindow(pid) {
  const player = await Player.findById(pid).lean();
  if (!player || player.isSold) return;
  const result = await getBidderCount(pid);
  const count = result.count ?? 0;
  const windowMs = 2 * 60 * 1000;

  if (count !== 0) {
    if (count === 1) {
      await exitSecondHighestForPlayerSingle(pid, null);
    }
    return;
  }

  // count=0: exactly one unique active bidder → sell only if 2 min elapsed
  if (await shouldSellNoNewBidSinceExit(player, windowMs)) {
    await sellPlayer(pid, null);
  }
}

async function sellingSingleBidSinceStarting() {
  if (!(await isCronEnabled('cronSingleBidFinalizerEnabled'))) {
    console.log('⏸️ 11:30 PM single-bid finalizer disabled via admin settings.');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running 11:30 PM single-bid finalizer (no counter bid since start)`);
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
          const { count } = await getBidderCount(playerId);
          if (count !== 0) {
            console.log(`   ⏭️ Skip ${playerId}: not a single bidder (count=${count}) – NEVER sell with 2 active bids`);
            return;
          }
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

  // Only allow this job to run from 11:25 PM–1:00 AM IST
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
  const isAfter1125 = hour > 23 || (hour === 23 && minute >= 25);
  const isBefore1 = hour < 1 || (hour === 1 && minute === 0);
  if (!(isAfter1125 || isBefore1)) {
    console.log('⏸️ Ten-minute single-bid monitor skipped (outside 11:25 PM–1:00 AM IST window).');
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
  // Note: cronBulkExitEnabled only affects bulk windows. Exit-only runs 11:00–11:20 PM.
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

/**
 * 12:45 AM IST one-time sweep:
 * Sell any unsold player that currently has exactly one active bidder (2nd already exited).
 */
async function oneTimeSellAfterExitSweep() {
  const settings = await getCronSettings();
  if (settings.cronSingleBidEnabled === false) {
    console.log('⏸️ One-time 12:45 AM sell sweep disabled via admin settings (cronSingleBidEnabled=false).');
    return;
  }

  console.log(`⏱️ [${new Date().toISOString()}] Running one-time immediate sell-after-exit sweep`);
  try {
    const result = await getUnsoldPlayers();
    const players = result.players || [];
    let sold = 0;

    const batchSize = parseInt(process.env.SCHEDULER_MONITOR_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE;
    await runInBatches(
      players,
      batchSize,
      async ({ _id: pid, id }) => {
        const playerId = pid || id;
        const player = await Player.findById(playerId).lean();
        if (!player || player.isSold) return;
        const bidCountResult = await getBidderCount(playerId);
        const count = bidCountResult.count ?? 0;
        if (count !== 0) return; // 2+ active bidders → never sell
        await sellPlayer(playerId, null);
        sold += 1;
      }
    );

    console.log(`   ✅ One-time 12:45 AM sweep sold ${sold} player(s).`);
  } catch (err) {
    console.error('⚠️ oneTimeSellAfterExitSweep error:', err.message);
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

const VALID_PLAYER_TYPES = ['Sapphire', 'Emerald', 'Gold', 'Silver'];

const AUTO_MODE_FLAG_KEYS = [
  'cronBulkExitEnabled',
  'cronSingleBidEnabled',
  'cronSingleBidFinalizerEnabled',
  'cronLockEnabled',
];

async function syncAutoModeCronFlags() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;
    const armed = getArmedCronFlags();
    let changed = false;
    for (const key of AUTO_MODE_FLAG_KEYS) {
      if (doc[key] !== armed[key]) {
        doc[key] = armed[key];
        changed = true;
      }
    }
    if (!changed) return;
    await doc.save();
    invalidateSettingsCache();
    console.log(
      `🤖 Auto Mode flags synced to ${armed.phaseId}: bulk=${armed.cronBulkExitEnabled} lock=${armed.cronLockEnabled} uncontested=${armed.cronSingleBidFinalizerEnabled} sell=${armed.cronSingleBidEnabled}`
    );
  } catch (err) {
    console.error('   ❌ syncAutoModeCronFlags error:', err.message);
  }
}

async function auctionAutoModeStartJob() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;
    const categories = doc.auctionAutoModeCategories || ['Gold', 'Silver', 'Sapphire', 'Emerald'];
    const typesToEnable = categories.filter((t) => VALID_PLAYER_TYPES.includes(String(t).trim()));
    if (typesToEnable.length === 0) return;

    console.log(`🤖 [${new Date().toISOString()}] Auction Auto Mode START: enabling ${typesToEnable.join(', ')}`);
    for (const type of VALID_PLAYER_TYPES) {
      const enable = typesToEnable.includes(type);
      const r = await Player.updateMany({ type, isSold: false }, { $set: { isActive: enable } });
      if (r.modifiedCount > 0) console.log(`   → ${type}: ${r.modifiedCount} players ${enable ? 'enabled' : 'disabled'}`);
    }
    doc.cronBulkExitEnabled = true;
    doc.cronSingleBidEnabled = false;
    doc.cronSingleBidFinalizerEnabled = false;
    await doc.save();
    invalidateSettingsCache();
    console.log(`   → bulk=ON, single-bid=OFF, finalizer=OFF (exit only until 10:45)`);
  } catch (err) {
    console.error('   ❌ auctionAutoModeStartJob error:', err.message);
  }
}

async function auctionAutoModeBulk1Off() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;

    console.log(`🤖 [${new Date().toISOString()}] Auction Auto Mode @ 10:45 PM: bulk OFF`);
    doc.cronBulkExitEnabled = false;
    doc.cronSingleBidEnabled = false;
    await doc.save();
    invalidateSettingsCache();
    console.log(`   → bulk=OFF, single-bid=OFF (pause until 11:30)`);
  } catch (err) {
    console.error('   ❌ auctionAutoModeBulk1Off error:', err.message);
  }
}

async function auctionAutoModeFinalizerOn() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;

    console.log(`🤖 [${new Date().toISOString()}] Auction Auto Mode @ 11:29 PM: finalizer ON`);
    doc.cronSingleBidFinalizerEnabled = true;
    doc.cronBulkExitEnabled = false;
    doc.cronSingleBidEnabled = false;
    await doc.save();
    invalidateSettingsCache();
    console.log(`   → finalizer=ON (11:30 sell: never-got-counter-bid players)`);
  } catch (err) {
    console.error('   ❌ auctionAutoModeFinalizerOn error:', err.message);
  }
}

async function auctionAutoModeBulk2On() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;

    console.log(`🤖 [${new Date().toISOString()}] Auction Auto Mode @ 11:30 PM: bulk window 2 ON`);
    doc.cronBulkExitEnabled = true;
    doc.cronSingleBidEnabled = false;
    await doc.save();
    invalidateSettingsCache();
    console.log(`   → bulk=ON, single-bid=OFF (exit only until 12:30 AM)`);
  } catch (err) {
    console.error('   ❌ auctionAutoModeBulk2On error:', err.message);
  }
}

async function auctionAutoModeBulk2Off() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;

    console.log(`🤖 [${new Date().toISOString()}] Auction Auto Mode @ 12:30 AM: bulk OFF`);
    doc.cronBulkExitEnabled = false;
    doc.cronSingleBidEnabled = false;
    await doc.save();
    invalidateSettingsCache();
    console.log(`   → bulk=OFF (pause until 12:45 sell-after-exit)`);
  } catch (err) {
    console.error('   ❌ auctionAutoModeBulk2Off error:', err.message);
  }
}

async function auctionAutoModeSellAfterExitOn() {
  try {
    const doc = await AppSettings.findOne();
    if (!doc || doc.auctionAutoModeEnabled !== true) return;

    console.log(`🤖 [${new Date().toISOString()}] Auction Auto Mode @ 12:44 AM: sell-after-exit ON`);
    doc.cronBulkExitEnabled = false;
    doc.cronSingleBidEnabled = true;
    await doc.save();
    invalidateSettingsCache();
    console.log(`   → single-bid=ON (12:45 sell already-solo; 12:50+ exit / sell if exited ≥ 2 min)`);
  } catch (err) {
    console.error('   ❌ auctionAutoModeSellAfterExitOn error:', err.message);
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

// 9:00–10:45 PM IST – bulk exit every 10 min (last tick 10:40). NO sell.
cron.schedule('0 0,10,20,30,40,50 21 * * *', () => {
  console.log(`⏰ [${new Date().toISOString()}] Bulk exit (9:00–10:45 PM window)`);
  runBulkExitJob();
}, { timezone: 'Asia/Kolkata' });
cron.schedule('0 0,10,20,30,40 22 * * *', () => {
  console.log(`⏰ [${new Date().toISOString()}] Bulk exit (9:00–10:45 PM window)`);
  runBulkExitJob();
}, { timezone: 'Asia/Kolkata' });

// 11:00 PM IST sharp – lock under-limit (admin categories)
cron.schedule('0 0 23 * * *', lockUnderLimitJob, {
  timezone: 'Asia/Kolkata',
});

// 11:30 PM: sell never-got-counter-bid, then start bulk window 2
cron.schedule('0 30 23 * * *', async () => {
  console.log(`⏰ [${new Date().toISOString()}] 11:30 PM: single-bid-only sell, then bulk window 2`);
  await sellingSingleBidSinceStarting();
  await auctionAutoModeBulk2On();
  await runBulkExitJob();
}, { timezone: 'Asia/Kolkata' });

// 11:40 PM–12:30 AM – bulk exit every 10 min (NO sell)
cron.schedule('0 40,50 23 * * *', () => {
  console.log(`⏰ [${new Date().toISOString()}] Bulk exit (11:30 PM–12:30 AM window)`);
  runBulkExitJob();
}, { timezone: 'Asia/Kolkata' });
cron.schedule('0 0,10,20,30 0 * * *', () => {
  console.log(`⏰ [${new Date().toISOString()}] Bulk exit (11:30 PM–12:30 AM window)`);
  runBulkExitJob();
}, { timezone: 'Asia/Kolkata' });

// ── Cron signatures (change these strings when night timing moves; freeze/math follow)
const CRON_AUCTION_AUTO_START = '0 0 21 * * *'; // e.g. 6 PM start → '0 0 18 * * *'
const CRON_SOLO_SELL = '0 45 0 * * *'; // e.g. 11:45 PM sell → '0 45 23 * * *'

registerNightTimingFromCrons({
  auctionStartCron: CRON_AUCTION_AUTO_START,
  soloSellCron: CRON_SOLO_SELL,
});

const soloSell = getSoloSellClockIst();
const counterBid1 = addMinutesToClock(soloSell.hour, soloSell.minute, 5);
const counterBid2 = addMinutesToClock(soloSell.hour, soloSell.minute, 10);
const sellArm = addMinutesToClock(soloSell.hour, soloSell.minute, -1);

// Solo-sell minute – sell anyone already down to 1 bidder (NO exits this minute)
cron.schedule(CRON_SOLO_SELL, () => oneTimeSellAfterExitSweep(), {
  timezone: 'Asia/Kolkata',
});

// +5 / +10 min after solo sell – exit 2nd-highest; sell if 2nd exited ≥ 2 min
cron.schedule(
  `0 ${counterBid1.minute} ${counterBid1.hour} * * *`,
  () => counterBidWindowJob(2),
  { timezone: 'Asia/Kolkata' }
);
cron.schedule(
  `0 ${counterBid2.minute} ${counterBid2.hour} * * *`,
  () => counterBidWindowJob(2),
  { timezone: 'Asia/Kolkata' }
);
cron.schedule('0 */5 1-3 * * *', () => counterBidWindowJob(2), {
  timezone: 'Asia/Kolkata',
});
cron.schedule('0 0 4 * * *', () => counterBidWindowJob(2), {
  timezone: 'Asia/Kolkata',
});

// Auto Mode flag flips (jobs no-op unless auctionAutoModeEnabled=true)
cron.schedule(CRON_AUCTION_AUTO_START, auctionAutoModeStartJob, { timezone: 'Asia/Kolkata' });
cron.schedule('0 45 22 * * *', auctionAutoModeBulk1Off, { timezone: 'Asia/Kolkata' });
cron.schedule('0 29 23 * * *', auctionAutoModeFinalizerOn, { timezone: 'Asia/Kolkata' });
cron.schedule('0 31 0 * * *', auctionAutoModeBulk2Off, { timezone: 'Asia/Kolkata' });
cron.schedule(
  `0 ${sellArm.minute} ${sellArm.hour} * * *`,
  auctionAutoModeSellAfterExitOn,
  { timezone: 'Asia/Kolkata' }
);
cron.schedule('* * * * *', syncAutoModeCronFlags, { timezone: 'Asia/Kolkata' });
syncAutoModeCronFlags();

console.log(
  `🕒 Auction scheduler running (start cron ${CRON_AUCTION_AUTO_START} → solo sell ${CRON_SOLO_SELL}; freeze = prior minute, IST)…`
);