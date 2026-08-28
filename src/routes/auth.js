const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const db = require("../db");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { fullName, username, email, phone, password, referralUsername } = req.body;

  if (!fullName || !username || !email || !phone || !password) {
    return res.status(400).json({ error: "Full name, username, email, phone, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existingEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingEmail) return res.status(409).json({ error: "Email already registered" });

  const existingUsername = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existingUsername) return res.status(409).json({ error: "Username already taken" });

  // If a referral username was given, look up who it belongs to (optional — doesn't block signup if not found)
  let referredBy = null;
  if (referralUsername) {
    const referrer = db.prepare("SELECT id FROM users WHERE username = ?").get(referralUsername);
    if (referrer) referredBy = referrer.id;
  }

  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  db.prepare(
    `INSERT INTO users (id, full_name, username, email, phone, password_hash, referred_by, wallet_balance)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, fullName, username, email, phone, hash, referredBy);

  const token = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({
    token,
    user: { id, fullName, username, email, phone, wallet_balance: 0 },
  });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({
    token,
    user: {
      id: user.id,
      fullName: user.full_name,
      username: user.username,
      email: user.email,
      phone: user.phone,
      wallet_balance: user.wallet_balance,
    },
  });
});

module.exports = router;
