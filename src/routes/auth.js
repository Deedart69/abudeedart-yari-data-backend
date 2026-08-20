const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const db = require("../db");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "Email and password (min 8 chars) required" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, wallet_balance) VALUES (?, ?, ?, 0)"
  ).run(id, email, hash);

  const token = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({ token, user: { id, email, wallet_balance: 0 } });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: user.id, email: user.email, wallet_balance: user.wallet_balance } });
});

module.exports = router;
