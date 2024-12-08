const User = require("../models/User"); // Import the User model

/**
 * Middleware to validate the user performing an action.
 * Ensures the user exists in the database and is not an admin.
 */
async function validateUser(req, res, next) {
  const { bidder, userId } = req.body; // Extract user ID from the request body
  const userIdToCheck = bidder || userId;

  try {
    // Check if the user exists in the database
    const user = await User.findById(userIdToCheck);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Check if the user is an admin
    if (user.isAdmin) {
      return res.status(403).json({ message: "Admins are not allowed to perform this action." });
    }

    // If the user is valid and not an admin, proceed to the next middleware or route
    next();
  } catch (error) {
    console.error("Error validating user:", error);
    res.status(500).json({ message: "Internal server error." });
  }
}

module.exports = validateUser;
