const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const { pool } = require("../db");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { fullName, username, email, phone, password, referralUsername } = req.body;

  if (!fullName || !username || !email || !phone || !password) {
    return res.status(400).json({ error: "Full name, username, email, phone, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existingEmail = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existingEmail.rows.length > 0) return res.status(409).json({ error: "Email already registered" });

  const existingUsername = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (existingUsername.rows.length > 0) return res.status(409).json({ error: "Username already taken" });

  let referredBy = null;
  if (referralUsername) {
    const referrer = await pool.query("SELECT id FROM users WHERE username = $1", [referralUsername]);
    if (referrer.rows.length > 0) referredBy = referrer.rows[0].id;
  }

  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, password_hash, referred_by, wallet_balance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
    [id, fullName, username, email, phone, hash, referredBy]
  );

  const token = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({
    token,
    user: { id, fullName, username, email, phone, wallet_balance: 0 },
  });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
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
