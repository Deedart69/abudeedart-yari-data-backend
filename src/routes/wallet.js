const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const paystack = require("../services/paystack");

const router = express.Router();

// Credits a user's wallet exactly once per unique reference. This is the
// single choke point every funding path (webhook, verify-on-return) goes
// through, so double-crediting is structurally impossible, not just unlikely.
function creditWallet({ userId, amountKobo, reference, meta }) {
  const already = db.prepare("SELECT id FROM wallet_ledger WHERE reference = ?").get(reference);
  if (already) return; // already processed — safe to call this twice

  const tx = db.transaction(() => {
    const user = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(userId);
    const newBalance = user.wallet_balance + amountKobo;
    db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(newBalance, userId);
    db.prepare(
      `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
       VALUES (?, ?, 'funding', ?, ?, ?, ?)`
    ).run(uuid(), userId, amountKobo, newBalance, reference, JSON.stringify(meta || {}));
  });
  tx();
}

// 1. Frontend calls this to start a top-up. Returns a Paystack checkout URL.
router.post("/fund/initialize", requireAuth, async (req, res) => {
  const { amountNaira } = req.body;
  if (!amountNaira || amountNaira < 100) {
    return res.status(400).json({ error: "Minimum top-up is ₦100" });
  }
  const user = db.prepare("SELECT email FROM users WHERE id = ?").get(req.userId);
  const reference = `fund_${uuid()}`;
  const amountKobo = Math.round(amountNaira * 100);

  db.prepare(
    "INSERT INTO payments (id, user_id, reference, amount, status) VALUES (?, ?, ?, ?, 'pending')"
  ).run(uuid(), req.userId, reference, amountKobo);

  const data = await paystack.initializeTransaction({
    email: user.email,
    amountKobo,
    reference,
    callbackUrl: process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`,
  });

  res.json({ authorization_url: data.authorization_url, reference });
});

// 2. Fallback path: if the frontend redirects back before the webhook lands,
// this actively checks Paystack rather than trusting the redirect alone.
router.get("/fund/verify/:reference", requireAuth, async (req, res) => {
  const { reference } = req.params;
  const result = await paystack.verifyTransaction(reference);

  if (result.status === "success") {
    creditWallet({
      userId: req.userId,
      amountKobo: result.amount,
      reference,
      meta: { channel: result.channel },
    });
    db.prepare("UPDATE payments SET status = 'success' WHERE reference = ?").run(reference);
  } else {
    db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(reference);
  }

  const user = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.userId);
  res.json({ status: result.status, wallet_balance: user.wallet_balance });
});

// 3. The real source of truth: Paystack calls this server-to-server the
// moment a payment succeeds, independent of whether the customer's browser
// ever makes it back to your site.
// Mount this route with express.raw() in server.js — signature verification
// needs the exact raw bytes, not the parsed JSON body.
router.post("/webhook/paystack", (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!paystack.verifyWebhookSignature(req.body, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(req.body.toString());
  if (event.event === "charge.success") {
    const { reference, amount, customer } = event.data;
    const payment = db.prepare("SELECT user_id FROM payments WHERE reference = ?").get(reference);
    if (payment) {
      creditWallet({
        userId: payment.user_id,
        amountKobo: amount,
        reference,
        meta: { email: customer.email },
      });
      db.prepare("UPDATE payments SET status = 'success' WHERE reference = ?").run(reference);
    }
  }

  res.sendStatus(200); // Paystack retries on non-200, so always ack once handled
});

router.get("/balance", requireAuth, (req, res) => {
  const user = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.userId);
  res.json({ wallet_balance: user.wallet_balance });
});

module.exports = router;
