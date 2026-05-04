const mongoose = require("mongoose");

function toObjectId(raw) {
  if (!raw) return null;
  if (raw instanceof mongoose.Types.ObjectId) return raw;
  if (typeof raw === "string" && mongoose.Types.ObjectId.isValid(raw)) {
    return new mongoose.Types.ObjectId(raw);
  }
  return null;
}

function getTournamentIdFromRequest(req) {
  if (!req) return null;
  const raw =
    req.query?.tournamentId ||
    req.body?.tournamentId ||
    req.params?.tournamentId ||
    req.headers?.["x-tournament-id"] ||
    req.headers?.["x-active-tournament"];
  return toObjectId(raw);
}

function withTournamentFilter(base = {}, tournamentId) {
  if (!tournamentId) return { ...base };
  return { ...base, tournamentId };
}

function attachTournamentId(payload = {}, tournamentId) {
  if (!tournamentId) return { ...payload };
  return { ...payload, tournamentId };
}

module.exports = {
  toObjectId,
  getTournamentIdFromRequest,
  withTournamentFilter,
  attachTournamentId,
};
