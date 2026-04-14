/**
 * Real-time "who is viewing this player" presence for demand / engagement signals.
 * Clients join room player_watch:<playerId>; count is broadcast on join/leave/disconnect.
 */

function watchRoom(playerId) {
  return `player_watch:${String(playerId)}`;
}

function broadcastWatchCount(io, playerId) {
  const room = watchRoom(playerId);
  const n = io.sockets.adapter.rooms.get(room)?.size ?? 0;
  io.to(room).emit("player_watchers_update", {
    playerId: String(playerId),
    count: n,
  });
}

const WATCH_PREFIX = "player_watch:";

/** Live viewer count for one player (from socket rooms). */
function getWatchCountFromAdapter(io, playerId) {
  if (!io?.sockets?.adapter?.rooms) return 0;
  const room = watchRoom(playerId);
  return io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

/** Top players by concurrent watchers (for auction hub demand). */
function getTopWatchedPlayers(io, limit = 10) {
  if (!io?.sockets?.adapter?.rooms) return [];
  const list = [];
  for (const [name, set] of io.sockets.adapter.rooms) {
    if (typeof name === "string" && name.startsWith(WATCH_PREFIX)) {
      const pid = name.slice(WATCH_PREFIX.length);
      const n = set.size;
      if (n > 0) list.push({ playerId: pid, count: n });
    }
  }
  list.sort((a, b) => b.count - a.count);
  const lim = Math.max(1, Number(limit) || 10);
  return list.slice(0, lim);
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
function getWatchingSet(socket) {
  if (!socket.data.watchingPlayerIds) {
    socket.data.watchingPlayerIds = new Set();
  }
  return socket.data.watchingPlayerIds;
}

function attachPlayerWatchHandlers(socket, io) {
  socket.on("watch_player", (data) => {
    const nextId = data?.playerId != null ? String(data.playerId) : "";
    if (!nextId) return;

    const set = getWatchingSet(socket);
    if (set.has(nextId)) return;

    socket.join(watchRoom(nextId));
    set.add(nextId);
    broadcastWatchCount(io, nextId);
  });

  socket.on("unwatch_player", (data) => {
    const pid = data?.playerId != null ? String(data.playerId) : "";
    if (!pid) return;

    const set = getWatchingSet(socket);
    if (!set.has(pid)) return;

    socket.leave(watchRoom(pid));
    set.delete(pid);
    broadcastWatchCount(io, pid);
  });

  socket.on("disconnect", () => {
    const set = socket.data.watchingPlayerIds;
    if (!set || set.size === 0) return;
    const ids = [...set];
    setImmediate(() => {
      for (const playerId of ids) {
        broadcastWatchCount(io, playerId);
      }
    });
  });
}

module.exports = {
  attachPlayerWatchHandlers,
  watchRoom,
  broadcastWatchCount,
  getWatchCountFromAdapter,
  getTopWatchedPlayers,
};
