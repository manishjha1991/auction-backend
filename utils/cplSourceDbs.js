const mongoose = require('mongoose');

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readFirstEnv(keys = []) {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return '';
}

function readFirstInt(keys = [], fallback = null) {
  for (const key of keys) {
    if (!process.env[key]) continue;
    const n = parseInt(process.env[key], 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function detectCurrentCplNumber() {
  const currentDb = process.env.MONGO_DB_NAME || mongoose.connection?.name || '';
  const match = String(currentDb).match(/^cpl_(\d+)$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isNaN(n) ? null : n;
}

function buildDbRange({ from, to }) {
  const safeFrom = Math.max(1, parseInt(from, 10) || 1);
  const safeTo = Math.max(safeFrom, parseInt(to, 10) || safeFrom);
  const dbs = [];
  for (let i = safeFrom; i <= safeTo; i += 1) {
    dbs.push(`cpl_${i}`);
  }
  return dbs;
}

function resolveCplSourceDbs(options = {}) {
  const explicitEnvKeys = options.explicitEnvKeys || [];
  const fromEnvKeys = options.fromEnvKeys || [];
  const toEnvKeys = options.toEnvKeys || [];
  const defaultFrom = Math.max(1, parseInt(options.defaultFrom, 10) || 15);
  const includeCurrent = !!options.includeCurrent;
  const fallbackSingle = options.fallbackSingle !== false;

  const explicit = splitCsv(readFirstEnv(explicitEnvKeys));
  if (explicit.length) return explicit;

  const currentNum = detectCurrentCplNumber();
  const from = readFirstInt(fromEnvKeys, defaultFrom);

  const toFromEnv = readFirstInt(toEnvKeys, null);
  const autoTo = currentNum != null ? (includeCurrent ? currentNum : currentNum - 1) : null;
  const to = toFromEnv != null ? toFromEnv : autoTo;

  if (to == null || to < from) {
    if (!fallbackSingle) return [];
    const fallbackNum = Math.max(1, currentNum || from);
    return [`cpl_${fallbackNum}`];
  }

  return buildDbRange({ from, to });
}

module.exports = {
  resolveCplSourceDbs,
};
