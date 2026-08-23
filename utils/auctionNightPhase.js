/**
 * Night-phase flags for Auto Mode (IST).
 *
 * Timing is not configured here. scheduler.js registers cron expressions and calls
 * registerNightTimingFromCrons({ auctionStartCron, soloSellCron }) so freeze /
 * phase math follows those cron signatures.
 */

/** Defaults until scheduler registers real crons. */
let auctionStartHourIst = 21;
let auctionStartMinuteIst = 0;
let soloSellHourIst = 0;
let soloSellMinuteIst = 45;

/**
 * Parse node-cron expr to a single IST hour+minute.
 * Supports 5-field (min hour …) or 6-field (sec min hour …).
 * Hour/minute must be plain numbers (not lists/ranges/steps).
 */
function parseCronHourMinute(cronExpr) {
  const parts = String(cronExpr || '').trim().split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`Invalid cron (need 5 or 6 fields): ${cronExpr}`);
  }
  const hasSeconds = parts.length >= 6;
  const minuteTok = hasSeconds ? parts[1] : parts[0];
  const hourTok = hasSeconds ? parts[2] : parts[1];
  if (/[*,\-\/]/.test(minuteTok) || /[*,\-\/]/.test(hourTok)) {
    throw new Error(`Cron hour/minute must be a single number (got "${cronExpr}")`);
  }
  const minute = Number(minuteTok);
  const hour = Number(hourTok);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid cron minute in "${cronExpr}"`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid cron hour in "${cronExpr}"`);
  }
  return { hour, minute };
}

function todMinutes(hour, minute) {
  return hour * 60 + minute;
}

/** Minutes from clock A to clock B, crossing midnight if needed. */
function minutesBetweenClocks(fromHour, fromMinute, toHour, toMinute) {
  const from = todMinutes(fromHour, fromMinute);
  const to = todMinutes(toHour, toMinute);
  return (to - from + 24 * 60) % (24 * 60);
}

/**
 * Call once from scheduler.js with the same cron strings passed to cron.schedule.
 */
function registerNightTimingFromCrons({ auctionStartCron, soloSellCron }) {
  const start = parseCronHourMinute(auctionStartCron);
  const sell = parseCronHourMinute(soloSellCron);
  auctionStartHourIst = start.hour;
  auctionStartMinuteIst = start.minute;
  soloSellHourIst = sell.hour;
  soloSellMinuteIst = sell.minute;
}

function getSoloSellClockIst() {
  return { hour: soloSellHourIst, minute: soloSellMinuteIst };
}

function getAuctionStartClockIst() {
  return { hour: auctionStartHourIst, minute: auctionStartMinuteIst };
}

/** Solo-sell time as minutes after auction-start cron (not a hardcoded 9 PM). */
function getSoloSellMinutesFromAuctionStart() {
  return minutesBetweenClocks(
    auctionStartHourIst,
    auctionStartMinuteIst,
    soloSellHourIst,
    soloSellMinuteIst
  );
}

/** @deprecated alias — same as getSoloSellMinutesFromAuctionStart */
function getSoloSellMinutesFromNinePm() {
  return getSoloSellMinutesFromAuctionStart();
}

function getIstHourMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const bag = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') bag[p.type] = p.value;
  });
  return { hour: Number(bag.hour), minute: Number(bag.minute) };
}

/**
 * Minutes since auction-start cron (same night-cycle math as the old "from 9 PM",
 * but the start hour/minute come from the start cron signature).
 *
 * Overnight window ends at 9:00 AM IST (unchanged from original minutesFromNinePm).
 */
function minutesFromAuctionStart(now = new Date()) {
  const { hour, minute } = getIstHourMinute(now);
  const tod = todMinutes(hour, minute);
  const start = todMinutes(auctionStartHourIst, auctionStartMinuteIst);
  if (tod >= start) return tod - start;
  // After midnight until 9:00 AM — still counted in the night cycle that started previous evening
  if (tod < 9 * 60) return tod + 24 * 60 - start;
  // Daytime before next start → negative (waiting), same as legacy minutesFromNinePm
  return tod - start;
}

/** @deprecated alias for callers still using the old name */
function minutesFromNinePm(now = new Date()) {
  return minutesFromAuctionStart(now);
}

/**
 * Last full minute before the solo-sell cron time.
 */
function isInPreSoloSellFreeze(now = new Date()) {
  const m = minutesFromAuctionStart(now);
  if (typeof m !== 'number' || m < 0) return false;
  const sell = getSoloSellMinutesFromAuctionStart();
  return m >= sell - 1 && m < sell;
}

function getPhases() {
  const sell = getSoloSellMinutesFromAuctionStart();
  return [
    { id: 'waiting', until: 0 },
    { id: 'bulk1', until: 105 },
    { id: 'pauseAfterBulk1', until: 120 },
    { id: 'lock', until: 150 },
    { id: 'bulk2', until: 210 },
    { id: 'pauseBeforeSell', until: sell },
    { id: 'sellAfterExit', until: 420 },
    { id: 'ended', until: Infinity },
  ];
}

function getAuctionNightPhase(now = new Date()) {
  const m = minutesFromAuctionStart(now);
  if (m < 0) return { id: 'waiting', minutesFromStart: m };
  for (const p of getPhases()) {
    if (m < p.until) return { id: p.id, minutesFromStart: m };
  }
  return { id: 'ended', minutesFromStart: m };
}

function getExpectedCronFlags(phaseId) {
  if (phaseId === 'bulk1') {
    return {
      cronBulkExitEnabled: true,
      cronSingleBidEnabled: false,
      cronSingleBidFinalizerEnabled: false,
      cronLockEnabled: false,
    };
  }
  if (phaseId === 'lock') {
    return {
      cronBulkExitEnabled: false,
      cronSingleBidEnabled: false,
      cronSingleBidFinalizerEnabled: false,
      cronLockEnabled: true,
    };
  }
  if (phaseId === 'bulk2') {
    return {
      cronBulkExitEnabled: true,
      cronSingleBidEnabled: false,
      cronSingleBidFinalizerEnabled: true,
      cronLockEnabled: false,
    };
  }
  if (phaseId === 'sellAfterExit') {
    return {
      cronBulkExitEnabled: false,
      cronSingleBidEnabled: true,
      cronSingleBidFinalizerEnabled: false,
      cronLockEnabled: false,
    };
  }
  return {
    cronBulkExitEnabled: false,
    cronSingleBidEnabled: false,
    cronSingleBidFinalizerEnabled: false,
    cronLockEnabled: false,
  };
}

function getArmedCronFlags(now = new Date()) {
  const { id, minutesFromStart: m } = getAuctionNightPhase(now);
  const flags = getExpectedCronFlags(id);
  const sell = getSoloSellMinutesFromAuctionStart();
  if (typeof m === 'number' && m >= 0) {
    if (m >= 118 && m < 150) flags.cronLockEnabled = true;
    if (m >= 148 && m < 155) flags.cronSingleBidFinalizerEnabled = true;
    if (m >= sell - 2 && m < 420) flags.cronSingleBidEnabled = true;
  }
  return { ...flags, phaseId: id };
}

/** Add delta minutes to an IST hour/minute clock (wraps 24h). */
function addMinutesToClock(hour, minute, deltaMinutes) {
  const total = (todMinutes(hour, minute) + deltaMinutes + 24 * 60) % (24 * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

module.exports = {
  getAuctionNightPhase,
  getExpectedCronFlags,
  getArmedCronFlags,
  minutesFromNinePm,
  minutesFromAuctionStart,
  isInPreSoloSellFreeze,
  getSoloSellClockIst,
  getAuctionStartClockIst,
  registerNightTimingFromCrons,
  parseCronHourMinute,
  addMinutesToClock,
  getSoloSellMinutesFromAuctionStart,
  getSoloSellMinutesFromNinePm,
};
