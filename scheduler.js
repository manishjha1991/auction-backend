const cron = require('node-cron');
const axios = require('axios');
const API_ENDPOINTS='https://cpl.in.net'
// const API_ENDPOINTS = "http://localhost:3000";
const API_BASE = `${API_ENDPOINTS}/api/bids`;
const EXIT_PATH = id => `${API_BASE}/${id}/exit-second-highest`;
const EXIT_ALL_PATH = `${API_BASE}/exit-second-highest/all`;
const SELL_PATH = id => `${API_BASE}/players/${id}/soldcrone`;
const SINGLE_PLAYER_PATH = id => `${API_BASE}/players/${id}/singlebid`;
const GET_UNSOLD_PLAYERS = `${API_BASE}/players?filter=unsold`;
const GET_BID_COUNT = id => `${API_BASE}/players/${id}/bidders`;
const LOCK_PATH = `${API_BASE}/lock-under-limit/all`;
const SINGLE_BID_PATH  = `${API_BASE}/players/singlebid`;
console.log('🕒 Auction scheduler running…');







// ---------------- existing helper ----------------
async function sellingSingleBidSinceStarting() {
  try {
    const { data } = await axios.post(SINGLE_BID_PATH);
    const ids = data.resultMain;

    if (!Array.isArray(ids) || ids.length === 0) {
      console.log('No single-bid players to finalize.');
      return;
    }

    for (const playerId of ids) {
      const resSold = await axios.post(SELL_PATH(playerId));
      console.log(`Sold player ${playerId}:`, resSold.data);
    }
  } catch (err) {
    console.error(
      'Error in finalizeSingleBidSinceStarting:',
      err.response?.data || err.message
    );
  }
}

// ---------------- cron schedule ------------------
// second minute hour  day mon dow
//   0      30    16   *   *   *
// cron.schedule(
//   '0 30 23 * * *',            // 23:30:00 IST every day
//   sellingSingleBidSinceStarting,
//   { timezone: 'Asia/Kolkata' }
// );

// console.log('🕒 Single-bid finalizer scheduled for 23:30 IST daily.');






// --- shared callback ---------------------------------------------------------
async function runBulkExit() {
  console.log(`⏱️ [${new Date().toISOString()}] Running bulk exit-second-highest/all`);
  try {
    const { data } = await axios.post(EXIT_ALL_PATH);
    console.log('   → bulk exit response:', data);
  } catch (err) {
    console.error('   ❌ bulk exit error:', err.message);
  }
}
/*
|--------------------------------------------------------------------------
| 1.  Every 15 min from 00:00 through 21:45  (sec  min  hrs)
|--------------------------------------------------------------------------
| second  minute   hour
 
// */
// cron.schedule('0 */15 0-22 * * *', runBulkExit, {
//   timezone: 'Asia/Kolkata'
// });

// //② The last three runs at 10:00, 10:15, and 10:30 IST
// cron.schedule(
//   '0 0,15,30 22 * * *',     // sec  min     hr=10
//   runBulkExit,
//   { timezone: 'Asia/Kolkata' }
// );


// // 2) 23:30 & 23:45
// cron.schedule(
//   '0 30,45 23 * * *',
//   runBulkExit,
//   { timezone: 'Asia/Kolkata' }
// );

// // 3) 00:00, 00:15, 00:30, 01:00, 01:15, 01:30, 02:00, 02:15, 02:30
// cron.schedule(
//   '0 0,15,30 0-2 * * *',
//   runBulkExit,
//   { timezone: 'Asia/Kolkata' }
// );
// console.log('🕒 bulk-exit runs every 15 min from 23:00 → 10:30 IST');









// ---------------------------------------------------------------------------
// Lock Account run exact at 22:59:59 IST each night
// ---------------------------------------------------------------------------

cron.schedule('59 59 22 * * *', async () => {          // 22:59:59 IST each night
  console.log(`⏱️  [${new Date().toISOString()}] running lock-under-limit/all`);
  try {
    const { data } = await axios.post(LOCK_PATH);
    console.log('   →', data.message);
  } catch (err) {
    console.error('   ❌ cron error:', err.response?.data ?? err.message);
  }
}, { timezone: 'Asia/Kolkata' });






// ---------------------------------------------------------------------------
// Your existing auction helper and check if second bidder exit the sold that Player run after 12 till 3 coclock night
// ---------------------------------------------------------------------------
/**
 * For a given player ID, poll the “bid count” endpoint every minute until
 * there is exactly one single bid remaining with no counter (count === 0).
 * When that happens, POST to sell that player.
 */
// async function handlePlayerAuctionToSellOneSingleBidRemainingAndNoCounterBid(pid) {
//   console.log(`▶️ [${new Date().toISOString()}] Auction window opened for ${pid}`);

//   let lastCount = Infinity;

//   const step = async () => {
//     try {
//       const res = await axios.get(GET_BID_COUNT(pid));
//       lastCount = res.data.count ?? 0;
//     } catch (e) {
//       console.error(`   ⚠️ bid count error for ${pid}:`, e.message);
//       return false;
//     }
   

//     if (lastCount === 0) {
//       // exactly one active bid with no counterbid
//       console.log(`   → exactly one single bid, finalizing sale for ${pid}`);
//       try {
//         await axios.post(SELL_PATH(pid), { playerID: pid });
//         console.log(`   ✅ sold ${pid}`);
//       } catch (e) {
//         console.error(`   ❌ sell error for ${pid}:`, e.message);
//       }
//       return true;   // done polling
//     } else {
      
//       // any other case: still multiple or no proper single bid
//       return false;  // keep polling
//     }
//   };

//   // initial run
//   if (await step() !== true) {
//     // then every minute
//     const interval = setInterval(async () => {
//       if (await step() === true) {
//         clearInterval(interval);
//         console.log(`   🛑 stopped polling for ${pid}`);
//       }
//     }, 60 * 1000);
//   }
// }

// ---------------------------------------------------------------------------
// CRON • every 30 min from 00:00 → 03:30 IST
// ---------------------------------------------------------------------------
// second   minute   hour
//   0        0,30   0-3          ← 00:00, 00:30, … 03:30
/**
 * Cron job: every minute, fetch all unsold players and
 * for each one start (or continue) its auction-to-sell check.
 */
/**
 * The “job” that runs your unsold‐players check each tick:
 *  - fetches all unsold players
 *  - for each one kicks off the per-player auction handler
 */
// async function job() {
//   console.log(`⏱️ [${new Date().toISOString()}] Running sold-single-bid check for all unsold players`);
//   try {
//     const { data } = await axios.get(GET_UNSOLD_PLAYERS);
//     const players = data.players || [];
//     console.log(`  • Found ${players.length} unsold player(s)`);

//     for (const { _id: pid } of players) {
//       handlePlayerAuctionToSellOneSingleBidRemainingAndNoCounterBid(pid);
//     }
//   } catch (err) {
//     console.error('⚠️ fetchUnsoldPlayers error:', err.message);
//   }
// }

// Schedule “job” at 00:30 & 00:45
// cron.schedule(
//   '0 30,45 0 * * *',
//   job,
//   { timezone: 'Asia/Kolkata' }
// );

// // Schedule “job” every 15 minutes during 01:00–01:45
// cron.schedule(
//   '0 0,15,30,45 1 * * *',
//   job,
//   { timezone: 'Asia/Kolkata' }
// );

// // Schedule “job” once at 02:00
// cron.schedule(
//   '0 0 2 * * *',
//   job,
//   { timezone: 'Asia/Kolkata' }
// );

console.log('✅ Auction scheduler started: will run at 00:30–02:00 IST every night.');



console.log('🕒 Auction scheduler running…');