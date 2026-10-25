const AppSettings = require('../models/AppSettings');

const DEFAULT_ROSTER_CAPS = {
  sapphireMax: 2,
  emeraldMax: 4,
  goldMax: 8,
  silverMax: 6,
  sapphireEmeraldMax: 4,
  sapphireMin: 0,
  emeraldMin: 2,
  sapphireEmeraldMin: 4,
  goldMin: 8,
  silverMin: 6,
};

const clampInt = (value, min, max, fallback) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const normalizeRosterCaps = (raw = {}) => ({
  sapphireMax: clampInt(raw.sapphireMax, 0, 12, DEFAULT_ROSTER_CAPS.sapphireMax),
  emeraldMax: clampInt(raw.emeraldMax, 0, 12, DEFAULT_ROSTER_CAPS.emeraldMax),
  goldMax: clampInt(raw.goldMax, 0, 20, DEFAULT_ROSTER_CAPS.goldMax),
  silverMax: clampInt(raw.silverMax, 0, 20, DEFAULT_ROSTER_CAPS.silverMax),
  sapphireEmeraldMax: clampInt(
    raw.sapphireEmeraldMax,
    0,
    16,
    DEFAULT_ROSTER_CAPS.sapphireEmeraldMax
  ),
  sapphireMin: clampInt(raw.sapphireMin, 0, 12, DEFAULT_ROSTER_CAPS.sapphireMin),
  emeraldMin: clampInt(raw.emeraldMin, 0, 12, DEFAULT_ROSTER_CAPS.emeraldMin),
  sapphireEmeraldMin: clampInt(
    raw.sapphireEmeraldMin,
    0,
    16,
    DEFAULT_ROSTER_CAPS.sapphireEmeraldMin
  ),
  goldMin: clampInt(raw.goldMin, 0, 20, DEFAULT_ROSTER_CAPS.goldMin),
  silverMin: clampInt(raw.silverMin, 0, 20, DEFAULT_ROSTER_CAPS.silverMin),
});

async function getRosterCaps() {
  const doc = await AppSettings.findOne().lean();
  return normalizeRosterCaps(doc?.rosterCaps || {});
}

function typeLimitMap(caps) {
  return {
    Sapphire: caps.sapphireMax,
    Emerald: caps.emeraldMax,
    Gold: caps.goldMax,
    Silver: caps.silverMax,
  };
}

function wouldExceedTypeLimits(counts, caps) {
  const limits = typeLimitMap(caps);
  for (const [k, v] of Object.entries(limits)) {
    if ((counts[k] || 0) > v) return true;
  }
  const es = (counts.Emerald || 0) + (counts.Sapphire || 0);
  if (es > caps.sapphireEmeraldMax) return true;
  return false;
}

module.exports = {
  DEFAULT_ROSTER_CAPS,
  normalizeRosterCaps,
  getRosterCaps,
  typeLimitMap,
  wouldExceedTypeLimits,
};
