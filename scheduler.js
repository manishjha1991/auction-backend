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
// async function sellingSingleBidSinceStarting() {
//   try {
//     const { data } = await axios.post(SINGLE_BID_PATH);
//     const ids = data.resultMain;

//     if (!Array.isArray(ids) || ids.length === 0) {
//       console.log('No single-bid players to finalize.');
//       return;
//     }

//     for (const playerId of ids) {
//       const resSold = await axios.post(SELL_PATH(playerId));
//       console.log(`Sold player ${playerId}:`, resSold.data);
//     }
//   } catch (err) {
//     console.error(
//       'Error in finalizeSingleBidSinceStarting:',
//       err.response?.data || err.message
//     );
//   }
// }

// // ---------------- cron schedule ------------------
// // second minute hour  day mon dow
// //   0      30    22   *   *   *
// cron.schedule(
//   '0 30 22 * * *',            // 22:30:00 IST every day (10:30 PM) - Sell single bid players
//   sellingSingleBidSinceStarting,
//   { timezone: 'Asia/Kolkata' }
// );

// console.log('🕒 Single-bid finalizer scheduled for 22:30 IST daily.');






// // --- shared callback ---------------------------------------------------------
// async function runBulkExit() {
//   console.log(`⏱️ [${new Date().toISOString()}] Running bulk exit-second-highest/all`);
//   try {
//     const { data } = await axios.post(EXIT_ALL_PATH);
//     console.log('   → bulk exit response:', data);
//   } catch (err) {
//     console.error('   ❌ bulk exit error:', err.message);
//   }
// }
// /*
// |--------------------------------------------------------------------------
// | 1.  Every 15 min from 00:00 through 23:45  (sec  min  hrs)
// |--------------------------------------------------------------------------
// | second  minute   hour
 
// // */
// cron.schedule('0 */15 0-23 * * *', runBulkExit, {
//   timezone: 'Asia/Kolkata'
// });











// ---------------------------------------------------------------------------
// Lock Account run exact at 22:00:00 IST (10 PM sharp) each night
// ---------------------------------------------------------------------------

// cron.schedule('0 0 22 * * *', async () => {          // 22:00:00 IST (10 PM sharp) each night
//   console.log(`⏱️  [${new Date().toISOString()}] running lock-under-limit/all at 10 PM IST`);
//   try {
//     const { data } = await axios.post(LOCK_PATH);
//     console.log('   →', data.message);
//     console.log(`   → Locked ${data.totalLocked} users for not meeting Gold requirements (1+ bought needs exactly 6 bidding = 7 total, 0 bought needs exactly 8 bidding = 8 total)`);
//   } catch (err) {
//     console.error('   ❌ cron error:', err.response?.data ?? err.message);
//   }
// }, { timezone: 'Asia/Kolkata' });







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

// Schedule "job" every 5 minutes starting from 23:30 IST (11:30 PM)
// cron.schedule(
//   '*/5 23 * * *',             // Every 5 minutes from 23:30 IST (11:30 PM)
//   job,
//   { timezone: 'Asia/Kolkata' }
// );

console.log('✅ Auction scheduler started:');
console.log('   • 10:30 PM IST - Sell single bid players (no counter bids since starting)');
console.log('   • 11:30 PM IST onwards - Check every 5 minutes for players where second bidder exited');



console.log('🕒 Auction scheduler running…');