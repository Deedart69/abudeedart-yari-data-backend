const express = require("express");
const { v4: uuid } = require("uuid");
const { pool, withTransaction } = require("../db");
const { requireAuth } = require("../middleware/auth");
const vtpass = require("../services/vtpass");

const router = express.Router();

router.get("/categories/:network", requireAuth, (req, res) => {
  const { network } = req.params;
  const all = vtpass.ALL_CATEGORIES[network] || [];
  const available = vtpass.AVAILABLE_CATEGORIES[network] || [];
  res.json({
    network,
    categories: all.map((cat) => ({
      id: cat,
      label: cat.toUpperCase(),
      available: available.includes(cat) || available.includes(cat === "cg" ? "sme" : cat),
    })),
  });
});

router.get("/plans/:network", requireAuth, async (req, res) => {
  const { network } = req.params;
  const category = req.query.category || "gifting";
  const lookupCategory = category === "cg" ? "sme" : category;

  const result = await pool.query(
    "SELECT id, label, data_volume, validity, selling_price FROM data_plans WHERE network = $1 AND category = $2 AND active = true ORDER BY selling_price",
    [network, lookupCategory]
  );

  if (result.rows.length === 0) {
    return res.json({ network, category, plans: [], available: false });
  }

  const plans = result.rows.map((p) => ({
    id: p.id,
    label: p.label,
    data_volume: p.data_volume,
    validity: p.validity,
    sale_naira: p.selling_price / 100,
  }));
  res.json({ network, category, plans, available: true });
});

router.post("/data", requireAuth, async (req, res) => {
  const { planId, phone } = req.body;
  if (!planId || !phone) {
    return res.status(400).json({ error: "planId and phone are required" });
  }

  const planRes = await pool.query("SELECT * FROM data_plans WHERE id = $1 AND active = true", [planId]);
  const plan = planRes.rows[0];
  if (!plan) return res.status(400).json({ error: "Plan not found or no longer available" });

  const saleKobo = plan.selling_price;
  const costKobo = plan.supplier_price;

  const userRes = await pool.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
  const user = userRes.rows[0];
  if (user.wallet_balance < saleKobo) {
    return res.status(402).json({ error: "Insufficient wallet balance" });
  }

  const orderId = uuid();
  const requestId = `order_${orderId}`.slice(0, 40);

  await withTransaction(async (client) => {
    const newBalance = user.wallet_balance - saleKobo;
    await client.query("UPDATE users SET wallet_balance = $1 WHERE id = $2", [newBalance, req.userId]);
    await client.query(
      `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
       VALUES ($1, $2, 'purchase', $3, $4, $5, $6)`,
      [uuid(), req.userId, -saleKobo, newBalance, orderId, JSON.stringify({ network: plan.network, phone, planId })]
    );
    await client.query(
      `INSERT INTO orders (id, user_id, network, phone, plan_code, plan_label, cost_price, sale_price, status, vtpass_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [orderId, req.userId, plan.network, phone, plan.vtpass_variation_code, plan.label, costKobo, saleKobo, requestId]
    );
  });

  let result;
  try {
    result = await vtpass.payExact({
      requestId,
      serviceID: plan.vtpass_service_id,
      variationCode: plan.vtpass_variation_code,
      phone,
    });
  } catch (err) {
    result = { code: "network_error", response_description: err.message };
  }

  const succeeded = result.code === "000" && result?.content?.transactions?.status === "delivered";
  const failed = result.code !== "000" && result.code !== "099";

  if (succeeded) {
    await pool.query("UPDATE orders SET status = 'success', vtpass_response = $1 WHERE id = $2", [
      JSON.stringify(result),
      orderId,
    ]);
  } else if (failed) {
    await withTransaction(async (client) => {
      const uRes = await client.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
      const newBalance = uRes.rows[0].wallet_balance + saleKobo;
      await client.query("UPDATE users SET wallet_balance = $1 WHERE id = $2", [newBalance, req.userId]);
      await client.query(
        `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
        [uuid(), req.userId, saleKobo, newBalance, `refund:${orderId}`, JSON.stringify({ reason: "vtpass_failed" })]
      );
      await client.query("UPDATE orders SET status = 'failed', vtpass_response = $1 WHERE id = $2", [
        JSON.stringify(result),
        orderId,
      ]);
    });
  } else {
    await pool.query("UPDATE orders SET vtpass_response = $1 WHERE id = $2", [JSON.stringify(result), orderId]);
  }

  const finalUserRes = await pool.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
  res.json({
    order_id: orderId,
    status: succeeded ? "success" : failed ? "failed" : "pending",
    wallet_balance: finalUserRes.rows[0].wallet_balance,
    vtpass_message: result.response_description,
  });
});

router.post("/airtime", requireAuth, async (req, res) => {
  const { network, phone, amountNaira } = req.body;
  if (!network || !phone || !amountNaira || amountNaira < 50) {
    return res.status(400).json({ error: "network, phone, and a minimum ₦50 amount are required" });
  }

  const MARKUP = parseFloat(process.env.MARKUP_PERCENT || "0.02");
  const costKobo = Math.round(amountNaira * 100);
  const saleKobo = Math.ceil(costKobo * (1 + MARKUP));

  const userRes = await pool.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
  const user = userRes.rows[0];
  if (user.wallet_balance < saleKobo) {
    return res.status(402).json({ error: "Insufficient wallet balance" });
  }

  const orderId = uuid();
  const requestId = `order_${orderId}`.slice(0, 40);

  await withTransaction(async (client) => {
    const newBalance = user.wallet_balance - saleKobo;
    await client.query("UPDATE users SET wallet_balance = $1 WHERE id = $2", [newBalance, req.userId]);
    await client.query(
      `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
       VALUES ($1, $2, 'purchase', $3, $4, $5, $6)`,
      [uuid(), req.userId, -saleKobo, newBalance, orderId, JSON.stringify({ network, phone, type: "airtime" })]
    );
    await client.query(
      `INSERT INTO orders (id, user_id, network, phone, plan_code, plan_label, cost_price, sale_price, status, vtpass_request_id)
       VALUES ($1, $2, $3, $4, 'airtime', $5, $6, $7, 'pending', $8)`,
      [orderId, req.userId, network, phone, `₦${amountNaira} Airtime`, costKobo, saleKobo, requestId]
    );
  });

  let result;
  try {
    result = await vtpass.buyAirtime({ requestId, network, phone, amountNaira });
  } catch (err) {
    result = { code: "network_error", response_description: err.message };
  }

  const succeeded = result.code === "000" && result?.content?.transactions?.status === "delivered";
  const failed = result.code !== "000" && result.code !== "099";

  if (succeeded) {
    await pool.query("UPDATE orders SET status = 'success', vtpass_response = $1 WHERE id = $2", [
      JSON.stringify(result),
      orderId,
    ]);
  } else if (failed) {
    await withTransaction(async (client) => {
      const uRes = await client.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
      const newBalance = uRes.rows[0].wallet_balance + saleKobo;
      await client.query("UPDATE users SET wallet_balance = $1 WHERE id = $2", [newBalance, req.userId]);
      await client.query(
        `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
        [uuid(), req.userId, saleKobo, newBalance, `refund:${orderId}`, JSON.stringify({ reason: "vtpass_failed" })]
      );
      await client.query("UPDATE orders SET status = 'failed', vtpass_response = $1 WHERE id = $2", [
        JSON.stringify(result),
        orderId,
      ]);
    });
  } else {
    await pool.query("UPDATE orders SET vtpass_response = $1 WHERE id = $2", [JSON.stringify(result), orderId]);
  }

  const finalUserRes = await pool.query("SELECT wallet_balance FROM users WHERE id = $1", [req.userId]);
  res.json({
    order_id: orderId,
    status: succeeded ? "success" : failed ? "failed" : "pending",
    wallet_balance: finalUserRes.rows[0].wallet_balance,
    vtpass_message: result.response_description,
  });
});

router.post("/resolve-pending", requireAuth, async (req, res) => {
  const pendingRes = await pool.query("SELECT * FROM orders WHERE user_id = $1 AND status = 'pending'", [
    req.userId,
  ]);
  const pending = pendingRes.rows;

  const resolved = [];
  for (const order of pending) {
    const result = await vtpass.requeryTransaction(order.vtpass_request_id);
    const status = result?.content?.transactions?.status;
    if (status === "delivered") {
      await pool.query("UPDATE orders SET status = 'success', vtpass_response = $1 WHERE id = $2", [
        JSON.stringify(result),
        order.id,
      ]);
      resolved.push({ order_id: order.id, status: "success" });
    } else if (status === "failed" || status === "reversed") {
      await withTransaction(async (client) => {
        const uRes = await client.query("SELECT wallet_balance FROM users WHERE id = $1", [order.user_id]);
        const newBalance = uRes.rows[0].wallet_balance + order.sale_price;
        await client.query("UPDATE users SET wallet_balance = $1 WHERE id = $2", [newBalance, order.user_id]);
        await client.query(
          `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, reference, meta)
           VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
          [uuid(), order.user_id, order.sale_price, newBalance, `refund:${order.id}`, JSON.stringify({ reason: status })]
        );
        await client.query("UPDATE orders SET status = 'failed', vtpass_response = $1 WHERE id = $2", [
          JSON.stringify(result),
          order.id,
        ]);
      });
      resolved.push({ order_id: order.id, status: "failed" });
    }
  }
  res.json({ resolved });
});

router.get("/orders", requireAuth, async (req, res) => {
  const ordersRes = await pool.query(
    "SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [req.userId]
  );
  res.json({ orders: ordersRes.rows });
});

module.exports = router;
