/**
 * Socket.IO realtime service.
 *
 * Rooms:
 *   user:<userId>      — every socket for that user joins this room on connect.
 *                        Used to push notifications and DMs to all of a user's
 *                        tabs/devices simultaneously.
 *
 * Events emitted from server:
 *   notification:new              { id, type, title, message, metadata, ... }
 *   notification:unread_count     { unread_count }
 *   message:new                   { id, sender_id, recipient_id, body, ... }
 *   message:read                  { message_id, reader_id }
 *   presence:online               { user_id }
 *   presence:offline              { user_id }
 *
 * Events handled from client:
 *   typing:start                  { peer_id }   -> relays to peer
 *   typing:stop                   { peer_id }   -> relays to peer
 *   presence:ping                 ()            -> keeps presence fresh
 *
 * Message SENDING is a REST call (POST /messages), not a socket event.
 * That keeps persistence + realtime cleanly separated and avoids duplicated
 * validation logic.
 */

const { verifyToken } = require("../utils/jwt");

let ioInstance = null;

/**
 * Tracks user -> set of socket ids currently connected for that user.
 * Used to derive presence: a user is "online" iff they have at least one
 * active socket.
 */
const userSockets = new Map();

function addSocket(userId, socketId) {
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(socketId);
  return set.size === 1; // true if this was the first socket => newly online
}

function removeSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    userSockets.delete(userId);
    return true; // true if that was the last socket => now offline
  }
  return false;
}

function isOnline(userId) {
  const set = userSockets.get(userId);
  return !!(set && set.size > 0);
}

/**
 * Install Socket.IO on an existing HTTP server.
 * Wires JWT auth at the handshake stage so we never hold unauth'd sockets.
 */
function initialize(httpServer) {
  // Lazy require so Socket.IO is optional in environments that don't need it.
  const { Server } = require("socket.io");

  ioInstance = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  // Handshake auth: accept token from auth payload or Authorization header.
  ioInstance.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/, "");
      if (!token) return next(new Error("Missing auth token"));
      const payload = verifyToken(token);
      socket.data.userId = payload.id;
      return next();
    } catch (e) {
      return next(new Error("Invalid auth token"));
    }
  });

  ioInstance.on("connection", (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);

    const becameOnline = addSocket(userId, socket.id);
    if (becameOnline) {
      // Broadcast presence — any client interested subscribes individually.
      ioInstance.emit("presence:online", { user_id: userId });
    }

    // Client-originated typing indicators
    socket.on("typing:start", ({ peer_id } = {}) => {
      if (!peer_id) return;
      ioInstance
        .to(`user:${peer_id}`)
        .emit("typing:start", { peer_id: userId });
    });
    socket.on("typing:stop", ({ peer_id } = {}) => {
      if (!peer_id) return;
      ioInstance
        .to(`user:${peer_id}`)
        .emit("typing:stop", { peer_id: userId });
    });

    // Presence keep-alive (optional; socket.io handles disconnect on its own)
    socket.on("presence:ping", () => {
      socket.emit("presence:pong", { user_id: userId });
    });

    socket.on("disconnect", () => {
      const becameOffline = removeSocket(userId, socket.id);
      if (becameOffline && ioInstance) {
        ioInstance.emit("presence:offline", { user_id: userId });
      }
    });
  });

  return ioInstance;
}

/**
 * Emit to every socket of a user. No-op if socket.io not initialized
 * or user has no active sockets — realtime is a best-effort UX layer.
 */
function emitToUser(userId, event, payload) {
  if (!ioInstance) return false;
  ioInstance.to(`user:${userId}`).emit(event, payload);
  return true;
}

module.exports = {
  initialize,
  emitToUser,
  isOnline,
  getOnlineUserIds: () => Array.from(userSockets.keys()),
};
