const cron = require('node-cron');
const axios = require('axios');

// This cron expression means: at minute 0 of every hour from 0 through 22 (inclusive).
// So it will run at 00:00, 01:00, 02:00, ... up to 22:00 every day. // 0 0-22 * * *
cron.schedule('0 0-22 * * *', async () => {
   
  try {
    // Replace with your actual server URL/port if needed.
    const response = await axios.post('https://cpl.in.net/api/bids/exit-second-highest/all');
    console.log('[Cron] Response:', response.data);
  } catch (error) {
    console.error('[Cron] Error calling exit-second-highest/all:', error.message);
  }
});

cron.schedule('0 22 * * *', async () => {
   // minute = 0, hour = 23, every day, every month, every weekday
    try {
      // Replace with your actual server URL/port if needed.
      const response = await axios.post('https://cpl.in.net/api/bids/sold/single-bid');
      console.log('[Cron] Response:', response.data);
    } catch (error) {
      console.error('[Cron] Error calling exit-second-highest/all:', error.message);
    }
  });