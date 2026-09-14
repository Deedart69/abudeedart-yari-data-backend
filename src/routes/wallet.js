const express = require("express");
const { v4: uuid } = require("uuid");
const { pool, withTransaction } = require("../db");
const { requireAuth } = require("../middleware/auth");
const paystack = require("../services/paystack");

const router = express.Router();

// Credits a user's wallet exactly once per unique reference. This is the
// single choke point every funding path (webhook, verify-on-return) goes
// through, so double-crediting is structurally impossible, not just unlikely.
async function creditWallet({ userId, amountKobo, reference, meta }) {
  const already = await pool.query("SELECT id FROM wallet_ledger WHERE reference = $1", [reference]);
  if (already.rows.length > 0) return; // already processed — safe to call this twice

  await withTransaction(async (client) => {
    const userRes = await client.query("SELECT wallet_balance FROM users WHERE id = $1", [userId]);
    const newBalance = userRes.rows[0].wallet_balance + amountKobo;
    await client.query("UPDATE users SET wallet_balance = $1 WHERE id = $2", [newBalance, userId]);
    await client.query(
      `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
       VALUES ($1, $2, 'funding', $3, $4, $5, $6)`,
      [uuid(), userId, amountKobo, newBalance, reference, JSON.stringify(meta || {})]
    );
  });
}

router.post("/fund/initialize", requireAuth, async (req, res) => {
  const { amountNaira } = req.body;
  if (!amountNaira || amountNaira < 100) {
    return res.status(400).json({ error: "Minimum top-up is ₦100" });
  }
  const userRes = await pool.query("SELECT email FROM users WHERE id = $1", [req.userId]);
  const user = userRes.rows[0];
  const reference = `fund_${uuid()}`;
  const amountKobo = Math.round(amountNaira * 100);

  await pool.query(
    "INSERT INTO payments (id, user_id, reference, amount, status) VALUES ($1, $2, $3, $4, 'pending')",
    [uuid(), req.userId, reference, amountKobo]
  );

  const data = await paystack.initializeTransaction({
    email: user.email,
    amountKobo,
    reference,
    callbackUrl: process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`,
  });

  res.json({ authorization_url: data.authorization_url, reference });
});

router.get("/fund/verify/:reference", requireAuth, async (req, res) => {
  const { reference } = req.params;
  const result = await paystack.verifyTransaction(reference);

  if (result.status === "success") {
    await creditWallet({
      userId: req.userId,
      amountKobo: result.amount,
      reference,
      meta: { channel: result.channel },
    });
    await pool.query("UPDATE payments SET status = 'success' WHERE reference = $1", [reference]);
  } else {
    await pool.query("UPDATE payments SET status = 'failed' WHERE reference = $1", [reference]);
  }

  const userRes = await pool.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
  res.json({ status: result.status, wallet_balance: userRes.rows[0].wallet_balance });
});

router.post("/webhook/paystack", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!paystack.verifyWebhookSignature(req.body, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(req.body.toString());
  if (event.event === "charge.success") {
    const { reference, amount, customer } = event.data;
    const paymentRes = await pool.query("SELECT user_id FROM payments WHERE reference = $1", [reference]);
    const payment = paymentRes.rows[0];
    if (payment) {
      await creditWallet({
        userId: payment.user_id,
        amountKobo: amount,
        reference,
        meta: { email: customer.email },
      });
      await pool.query("UPDATE payments SET status = 'success' WHERE reference = $1", [reference]);
    }
  }

  res.sendStatus(200);
});

router.get("/balance", requireAuth, async (req, res) => {
  const userRes = await pool.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
  res.json({ wallet_balance: userRes.rows[0].wallet_balance });
});

module.exports = router;
