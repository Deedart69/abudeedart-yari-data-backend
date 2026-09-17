const { Pool } = require("pg");

// Postgres on Neon — this replaces the old SQLite file, which lived on
// Render's disk and got wiped every redeploy. Neon is a separate, always-on
// database, so your data now survives deploys, restarts, everything.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      referred_by TEXT,
      wallet_balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      meta TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      network TEXT NOT NULL,
      phone TEXT NOT NULL,
      plan_code TEXT NOT NULL,
      plan_label TEXT NOT NULL,
      cost_price INTEGER NOT NULL,
      sale_price INTEGER NOT NULL,
      status TEXT NOT NULL,
      vtpass_request_id TEXT,
      vtpass_response TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      reference TEXT UNIQUE NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Your own catalog of data plans. Supplier price comes from VTpass and
    -- is refreshed by the admin "sync" action; selling_price is set by you
    -- and is the ONLY price ever shown to customers. Prices are stored in
    -- kobo (NGN * 100) to avoid floating-point rounding issues.
    CREATE TABLE IF NOT EXISTS data_plans (
      id TEXT PRIMARY KEY,
      network TEXT NOT NULL,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      data_volume TEXT,
      validity TEXT,
      vtpass_service_id TEXT NOT NULL,
      vtpass_variation_code TEXT NOT NULL,
      supplier_price INTEGER NOT NULL,
      selling_price INTEGER NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (vtpass_service_id, vtpass_variation_code)
    );
  `);

  // Migration for accounts created before this feature existed — safe to
  // run every startup, since IF NOT EXISTS makes it a no-op once applied.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dedicated_account_number TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dedicated_account_bank TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dedicated_account_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS paystack_customer_code TEXT;
  `);
}

// Runs a group of queries as one all-or-nothing transaction — used
// anywhere we touch wallet balance + ledger + orders together, so a crash
// mid-way can't leave money debited with nothing recorded.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initSchema, withTransaction };
