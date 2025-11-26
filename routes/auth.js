const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { name, email, password, teamName, teamImage } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const newUser = await User.create({
      name,
      email,
      password: hashedPassword,
      teamName,
      teamImage,
    });
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  console.log(req.body,"@@@@@@@@@@@@@@");
  const { email, password } = req.body;
  console.log(email, password,"@@@@@@@@@@@@@@");
  try {
    const user = await User.findOne({ email }).includeInactive();
    console.log(user,"#########");
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isActive === false && !user.isAdmin) {
      return res.status(403).json({ error: 'Account deactivated. Contact admin.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;