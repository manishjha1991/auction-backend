/**
 * Night-phase flags for Auto Mode (IST). Keep in sync with
 * auction-frontend/src/utils/auctionNightSchedule.js
 */

function minutesFromNinePm(now = new Date()) {
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
  const hour = Number(bag.hour);
  const minute = Number(bag.minute);
  const tod = hour * 60 + minute;
  const ninePm = 21 * 60;
  if (tod >= ninePm) return tod - ninePm;
  if (tod < 9 * 60) return tod + 24 * 60 - ninePm;
  return tod - ninePm;
}

const PHASES = [
  { id: 'waiting', until: 0 },
  { id: 'bulk1', until: 105 },
  { id: 'pauseAfterBulk1', until: 120 },
  { id: 'lock', until: 150 },
  { id: 'bulk2', until: 210 },
  { id: 'pauseBeforeSell', until: 225 },
  { id: 'sellAfterExit', until: 420 },
  { id: 'ended', until: Infinity },
];

function getAuctionNightPhase(now = new Date()) {
  const m = minutesFromNinePm(now);
  if (m < 0) return { id: 'waiting', minutesFromStart: m };
  for (const p of PHASES) {
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
  if (typeof m === 'number' && m >= 0) {
    if (m >= 118 && m < 150) flags.cronLockEnabled = true;
    if (m >= 148 && m < 155) flags.cronSingleBidFinalizerEnabled = true;
    if (m >= 223 && m < 420) flags.cronSingleBidEnabled = true;
  }
  return { ...flags, phaseId: id };
}

module.exports = { getAuctionNightPhase, getExpectedCronFlags, getArmedCronFlags };
