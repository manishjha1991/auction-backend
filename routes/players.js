
const express = require('express');
const multer = require('multer');
const router = express.Router();
const Player = require('../models/Player'); // Assuming Player is your model

// GET all players
router.get('/', async (req, res) => {
  try {
    const players = await Player.find(); // Fetch players from MongoDB
    res.status(200).json(players);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer setup for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './uploads/'); // Uploads directory
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage: storage });

// POST: Add Player
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { firstName, lastName, role, style, basePrice, playerType } = req.body;

    const newPlayer = new Player({
      name: `${firstName} ${lastName}`,
      role,
      style,
      basePrice,
      type: playerType,
      image: req.file.path, // Store image path
    });

    const savedPlayer = await newPlayer.save();
    res.status(201).json(savedPlayer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add player' });
  }
});
// PUT: Update Player Data

router.put('/:id', upload.single('image'), async (req, res) => {
  try {
    const { name, role, style, basePrice, playerType } = req.body;

    const updateData = {
      name,
      role,
      style,
      basePrice,
      type: playerType,
    };

    // Check if a new image is uploaded
    if (req.file) {
      updateData.image = req.file.path;
    }

    // Update the player document
    const updatedPlayer = await Player.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedPlayer) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.status(200).json(updatedPlayer);
  } catch (err) {
    console.error('Error updating player:', err);
    res.status(500).json({ error: 'Failed to update player' });
  }
});

// Place a bid
router.put("/:id/bid", async (req, res) => {
  const { id } = req.params;
  const { bidAmount, bidder } = req.body;

  try {
    const player = await Player.findById(id);

    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    if (player.currentBidder?.id === bidder.id) {
      return res.status(400).json({ message: "You cannot bid again until another user bids." });
    }

    if (bidAmount < player.currentBid + 1000000) {
      return res.status(400).json({ message: "Minimum bid increment is ₹10 Lakh." });
    }

    // Update player's bid
    player.currentBid = bidAmount;
    player.currentBidder = bidder;

    await player.save();

    res.json({ currentBid: player.currentBid, currentBidder: player.currentBidder });
  } catch (err) {
    res.status(500).json({ message: "Error updating bid" });
  }
});

// Mark a player as sold
router.put("/:id/sold", async (req, res) => {
  const { id } = req.params;

  try {
    const player = await Player.findByIdAndUpdate(id, { sold: true }, { new: true });

    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    res.json(player);
  } catch (err) {
    res.status(500).json({ message: "Error marking player as sold" });
  }
});

module.exports = router;




