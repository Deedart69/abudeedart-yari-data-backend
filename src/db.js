// db.js — SQLite for a fast local/small-scale start.
// Swap to Postgres later: the query shapes here are simple enough to port
// almost line-for-line (see README "Moving to Postgres").
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "datadock.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  wallet_balance INTEGER NOT NULL DEFAULT 0, -- kobo (NGN * 100), avoids float errors
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every change to a wallet balance is a row here. Balance on the user table
-- is a cache; this table is the source of truth / audit trail.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,              -- 'funding' | 'purchase' | 'refund'
  amount INTEGER NOT NULL,         -- kobo, positive=credit, negative=debit
  balance_after INTEGER NOT NULL,
  reference TEXT UNIQUE NOT NULL,  -- idempotency key (paystack ref or order id)
  meta TEXT,                       -- JSON blob for extra context
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  network TEXT NOT NULL,
  phone TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  plan_label TEXT NOT NULL,
  cost_price INTEGER NOT NULL,     -- kobo, what VTpass charged you
  sale_price INTEGER NOT NULL,     -- kobo, what you charged the customer
  status TEXT NOT NULL,            -- 'pending' | 'success' | 'failed'
  vtpass_request_id TEXT,
  vtpass_response TEXT,            -- JSON blob, raw response for debugging
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  reference TEXT UNIQUE NOT NULL,  -- paystack reference
  amount INTEGER NOT NULL,         -- kobo
  status TEXT NOT NULL,            -- 'pending' | 'success' | 'failed'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
