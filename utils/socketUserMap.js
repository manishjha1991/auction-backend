/**
 * Socket User Mapping Utility
 * Tracks which socket belongs to which userId for targeted notifications
 */

// Map: userId (string) -> Set of socketIds (user can have multiple tabs/devices)
const userSocketMap = new Map();

/**
 * Register a socket connection with a userId
 * @param {string} userId - User ID
 * @param {string} socketId - Socket ID
 */
const registerUserSocket = (userId, socketId) => {
  if (!userId || !socketId) return;
  
  const userIdStr = String(userId);
  if (!userSocketMap.has(userIdStr)) {
    userSocketMap.set(userIdStr, new Set());
  }
  userSocketMap.get(userIdStr).add(socketId);
  
  console.log(`📱 Socket registered: User ${userIdStr} -> Socket ${socketId}`);
};

/**
 * Unregister a socket connection
 * @param {string} socketId - Socket ID
 */
const unregisterSocket = (socketId) => {
  if (!socketId) return;
  
  // Find and remove this socket from all users
  for (const [userId, socketIds] of userSocketMap.entries()) {
    if (socketIds.has(socketId)) {
      socketIds.delete(socketId);
      console.log(`📱 Socket unregistered: User ${userId} -> Socket ${socketId}`);
      
      // Clean up empty sets
      if (socketIds.size === 0) {
        userSocketMap.delete(userId);
      }
      break;
    }
  }
};

/**
 * Get all socket IDs for a user
 * @param {string} userId - User ID
 * @returns {Array<string>} Array of socket IDs
 */
const getSocketIdsForUser = (userId) => {
  if (!userId) return [];
  const userIdStr = String(userId);
  const socketIds = userSocketMap.get(userIdStr);
  return socketIds ? Array.from(socketIds) : [];
};

/**
 * Get all socket IDs for multiple users
 * @param {Array<string>} userIds - Array of User IDs
 * @returns {Array<string>} Array of socket IDs (flattened, may have duplicates)
 */
const getSocketIdsForUsers = (userIds) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  
  const allSocketIds = [];
  userIds.forEach(userId => {
    const socketIds = getSocketIdsForUser(userId);
    allSocketIds.push(...socketIds);
  });
  
  // Remove duplicates
  return [...new Set(allSocketIds)];
};

/**
 * Get user ID for a socket (if stored)
 * @param {string} socketId - Socket ID
 * @returns {string|null} User ID or null
 */
const getUserIdForSocket = (socketId) => {
  if (!socketId) return null;
  
  for (const [userId, socketIds] of userSocketMap.entries()) {
    if (socketIds.has(socketId)) {
      return userId;
    }
  }
  return null;
};

/**
 * Get count of connected users
 * @returns {number} Number of unique users with active sockets
 */
const getConnectedUsersCount = () => {
  return userSocketMap.size;
};

/**
 * Get all connected user IDs
 * @returns {Array<string>} Array of user IDs
 */
const getAllConnectedUserIds = () => {
  return Array.from(userSocketMap.keys());
};

/**
 * Clear all mappings (useful for testing or reset)
 */
const clearAllMappings = () => {
  userSocketMap.clear();
  console.log('🗑️ All socket mappings cleared');
};

module.exports = {
  registerUserSocket,
  unregisterSocket,
  getSocketIdsForUser,
  getSocketIdsForUsers,
  getUserIdForSocket,
  getConnectedUsersCount,
  getAllConnectedUserIds,
  clearAllMappings
};







