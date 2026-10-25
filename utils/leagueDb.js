function parseLeagueDbName(name) {
  const m = String(name || '')
    .trim()
    .match(/^(cpl|gpl)_(\d+)$/i);
  if (!m) return null;
  return {
    raw: String(name).trim(),
    family: m[1].toLowerCase(),
    prefix: m[1],
    num: parseInt(m[2], 10),
  };
}

function seasonDbName(parsed, num) {
  if (!parsed) return `Gpl_${num}`;
  return `${parsed.prefix}_${num}`;
}

function currentLeagueDb() {
  const mongoose = require('mongoose');
  return (
    process.env.MONGO_DB_NAME ||
    mongoose.connection?.name ||
    ''
  ).trim();
}

module.exports = {
  parseLeagueDbName,
  seasonDbName,
  currentLeagueDb,
};
