const express = require("express");
const authenticateJWT = require("../middleware/authJWT");
const bidQueueService = require("../services/bidQueueService");

const router = express.Router();

router.get("/:playerId", authenticateJWT, async (req, res) => {
  try {
    const state = await bidQueueService.getQueueState(
      req.params.playerId,
      req.authenticatedUser._id
    );
    res.json(state);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/:playerId", authenticateJWT, async (req, res) => {
  try {
    const io = req.app.get("io");
    const maxBid = Number(req.body.maxBid);
    if (!Number.isFinite(maxBid) || maxBid <= 0) {
      return res.status(400).json({ message: "Valid maxBid is required." });
    }
    const r = await bidQueueService.enqueueUser({
      playerId: req.params.playerId,
      userId: req.authenticatedUser._id,
      maxBid,
      io,
    });
    if (!r.ok) {
      return res.status(r.status).json({ message: r.message });
    }
    res.json({ message: "Joined bid queue", queueCount: r.queueCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/:playerId", authenticateJWT, async (req, res) => {
  try {
    const io = req.app.get("io");
    const r = await bidQueueService.leaveQueue({
      playerId: req.params.playerId,
      userId: req.authenticatedUser._id,
      io,
    });
    if (!r.ok) {
      return res.status(r.status).json({ message: r.message });
    }
    res.json({ message: "Left bid queue" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:playerId", authenticateJWT, async (req, res) => {
  try {
    const io = req.app.get("io");
    const maxBid = Number(req.body.maxBid);
    if (!Number.isFinite(maxBid) || maxBid <= 0) {
      return res.status(400).json({ message: "Valid maxBid is required." });
    }
    const r = await bidQueueService.updateQueueMax({
      playerId: req.params.playerId,
      userId: req.authenticatedUser._id,
      maxBid,
      io,
    });
    if (!r.ok) {
      return res.status(r.status).json({ message: r.message });
    }
    res.json({ message: "Max bid updated" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
