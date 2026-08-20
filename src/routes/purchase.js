const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const vtpass = require("../services/vtpass");

const router = express.Router();
const MARKUP = parseFloat(process.env.MARKUP_PERCENT || "0.05");

// Live plan list with YOUR sale price (cost + markup) baked in, so the
// frontend never has to know VTpass's raw prices.
router.get("/plans/:network", requireAuth, async (req, res) => {
  const { network } = req.params;
  if (!vtpass.SERVICE_IDS[network]) return res.status(400).json({ error: "Unknown network" });

  const variations = await vtpass.getDataVariations(network);
  const plans = variations.map((v) => ({
    code: v.variation_code,
    label: v.name,
    cost_naira: parseFloat(v.variation_amount),
    sale_naira: Math.ceil(parseFloat(v.variation_amount) * (1 + MARKUP)),
  }));
  res.json({ network, plans });
});

// Debits the wallet and calls VTpass, in that order, inside one transaction
// so a crash between the two can't leave money debited with nothing delivered.
router.post("/data", requireAuth, async (req, res) => {
  const { network, phone, planCode } = req.body;
  if (!network || !phone || !planCode) {
    return res.status(400).json({ error: "network, phone, and planCode are required" });
  }

  const variations = await vtpass.getDataVariations(network);
  const plan = variations.find((v) => v.variation_code === planCode);
  if (!plan) return res.status(400).json({ error: "Plan not found — prices may have changed, refetch /plans" });

  const costKobo = Math.round(parseFloat(plan.variation_amount) * 100);
  const saleKobo = Math.ceil(costKobo * (1 + MARKUP));

  const user = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.userId);
  if (user.wallet_balance < saleKobo) {
    return res.status(402).json({ error: "Insufficient wallet balance" });
  }

  const orderId = uuid();
  const requestId = `order_${orderId}`.slice(0, 40); // VTpass caps request_id length

  // Debit first and record as 'pending' — if VTpass fails, we refund below.
  // This ordering means a customer is briefly debited during the call, never
  // "delivered but not charged", which is the failure mode that costs you money.
  const debit = db.transaction(() => {
    const newBalance = user.wallet_balance - saleKobo;
    db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(newBalance, req.userId);
    db.prepare(
      `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
       VALUES (?, ?, 'purchase', ?, ?, ?, ?)`
    ).run(uuid(), req.userId, -saleKobo, newBalance, orderId, JSON.stringify({ network, phone }));
    db.prepare(
      `INSERT INTO orders (id, user_id, network, phone, plan_code, plan_label, cost_price, sale_price, status, vtpass_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(orderId, req.userId, network, phone, planCode, plan.name, costKobo, saleKobo, requestId);
  });
  debit();

  let result;
  try {
    result = await vtpass.buyData({ requestId, network, phone, variationCode: planCode });
  } catch (err) {
    result = { code: "network_error", response_description: err.message };
  }

  const succeeded = result.code === "000" && result?.content?.transactions?.status === "delivered";
  const failed = result.code !== "000" && result.code !== "099"; // 099 = processing, needs requery

  if (succeeded) {
    db.prepare("UPDATE orders SET status = 'success', vtpass_response = ? WHERE id = ?")
      .run(JSON.stringify(result), orderId);
  } else if (failed) {
    // Refund: reverse the debit under a NEW reference (refund:<orderId>) so
    // it can't collide with the original debit entry.
    const refundTx = db.transaction(() => {
      const u = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.userId);
      const newBalance = u.wallet_balance + saleKobo;
      db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(newBalance, req.userId);
      db.prepare(
        `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
         VALUES (?, ?, 'refund', ?, ?, ?, ?)`
      ).run(uuid(), req.userId, saleKobo, newBalance, `refund:${orderId}`, JSON.stringify({ reason: "vtpass_failed" }));
      db.prepare("UPDATE orders SET status = 'failed', vtpass_response = ? WHERE id = ?")
        .run(JSON.stringify(result), orderId);
    });
    refundTx();
  } else {
    // Ambiguous ("099" / timeout) — do NOT refund automatically. Leave as
    // pending and resolve via requery (see /purchase/resolve-pending below),
    // otherwise you risk refunding an order VTpass actually delivered.
    db.prepare("UPDATE orders SET vtpass_response = ? WHERE id = ?").run(JSON.stringify(result), orderId);
  }

  const finalUser = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(req.userId);
  res.json({
    order_id: orderId,
    status: succeeded ? "success" : failed ? "failed" : "pending",
    wallet_balance: finalUser.wallet_balance,
    vtpass_message: result.response_description,
  });
});

// Run this on a schedule (e.g. every 2 min via cron) for any order still
// 'pending' after a minute or two, to resolve ones VTpass left ambiguous.
router.post("/resolve-pending", requireAuth, async (req, res) => {
  const pending = db
    .prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'")
    .all(req.userId);

  const resolved = [];
  for (const order of pending) {
    const result = await vtpass.requeryTransaction(order.vtpass_request_id);
    const status = result?.content?.transactions?.status;
    if (status === "delivered") {
      db.prepare("UPDATE orders SET status = 'success', vtpass_response = ? WHERE id = ?")
        .run(JSON.stringify(result), order.id);
      resolved.push({ order_id: order.id, status: "success" });
    } else if (status === "failed" || status === "reversed") {
      const refundTx = db.transaction(() => {
        const u = db.prepare("SELECT wallet_balance FROM users WHERE id = ?").get(order.user_id);
        const newBalance = u.wallet_balance + order.sale_price;
        db.prepare("UPDATE users SET wallet_balance = ? WHERE id = ?").run(newBalance, order.user_id);
        db.prepare(
          `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
           VALUES (?, ?, 'refund', ?, ?, ?, ?)`
        ).run(uuid(), order.user_id, order.sale_price, newBalance, `refund:${order.id}`, JSON.stringify({ reason: status }));
        db.prepare("UPDATE orders SET status = 'failed', vtpass_response = ? WHERE id = ?")
          .run(JSON.stringify(result), order.id);
      });
      refundTx();
      resolved.push({ order_id: order.id, status: "failed" });
    }
    // else still processing — leave pending, try again next sweep
  }
  res.json({ resolved });
});

router.get("/orders", requireAuth, (req, res) => {
  const orders = db
    .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(req.userId);
  res.json({ orders });
});

module.exports = router;
