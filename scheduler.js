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
cron.schedule(
  '0 30 23 * * *',            // 23:30:00 IST every day
  sellingSingleBidSinceStarting,
  { timezone: 'Asia/Kolkata' }
);

console.log('🕒 Single-bid finalizer scheduled for 16:30 IST daily.');






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
 
*/
cron.schedule('0 */15 0-22 * * *', runBulkExit, {
  timezone: 'Asia/Kolkata'
});

/*
|--------------------------------------------------------------------------
| 2.  Extra runs at 22:00 and 22:15  (sec  min hour)
|--------------------------------------------------------------------------
*/
cron.schedule('0 0,15 22 * * *', runBulkExit, {
  timezone: 'Asia/Kolkata'
});

console.log('🕒 Bulk-exit cron active every 15 min until 22 : 15 IST.');


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
async function handlePlayerAuctionToSellOneSingleBidRemaingAndNocounterBid(pid) {
  console.log(`▶️ [${new Date().toISOString()}] Auction window opened for ${pid}`);

  const step = async () => {
    // 1) Check active bidders
    let count = 0;
    try {
      const res = await axios.get(GET_BID_COUNT(pid));
      count = res.data.count || 0;
    } catch (e) {
      console.error(`  ⚠️ bid count error for ${pid}:`, e.message);
      return;
    }
    console.log(`   • active bidders for ${pid}: ${count}`);

    if (count <= 1) {
      // finalize
      console.log(`   → only ${count} bidder(s), finalizing sale for ${pid}`);
      await axios.post(SELL_PATH(pid))
        .then(() => console.log(`   ✅ sold ${pid}`))
        .catch(e => console.error(`   ❌ sell error for ${pid}:`, e.message));
    } else {
      await runBulkExit();
    }
  };

  step();
}

// ---------------------------------------------------------------------------
// CRON • every 30 min from 00:00 → 03:30 IST
// ---------------------------------------------------------------------------
// second   minute   hour
//   0        0,30   0-3          ← 00:00, 00:30, … 03:30
cron.schedule(
  '0 0,30 0-4 * * *',
  async () => {
    console.log(`⏱️ [${new Date().toISOString()}] Running for sold all single bid player if someone exit `);
    try {
      const { data } = await axios.get(GET_UNSOLD_PLAYERS);
      const players   = data.players || [];
      console.log(`  • Found ${players.length} unsold player(s)`);

      for (const { _id: pid } of players) {
        handlePlayerAuctionToSellOneSingleBidRemaingAndNocounterBid(pid);
      }
    } catch (err) {
      console.error('⚠️ fetchUnsoldPlayers error:', err.message);
    }
  },
  { timezone: 'Asia/Kolkata' }
);

// OPTIONAL: add a single run at 04:00 AM IST
// cron.schedule('0 0 4 * * *', handle4AM, { timezone: 'Asia/Kolkata' });

console.log('🕒 Auction scheduler active every 30 min from 00:00 → 03:30 IST.');



console.log('🕒 Auction scheduler running…');