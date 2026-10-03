const express = require("express");
const { v4: uuid } = require("uuid");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/adminAuth");
const vtpass = require("../services/vtpass");
const harisdata = require("../services/harisdata");
const router = express.Router();

// Pulls the CURRENT live prices from VTpass for every network+category we
// support, and upserts them into data_plans. Supplier price is always
// overwritten with the fresh value. Selling price is set ONLY on first
// insert (defaults to supplier price — you're expected to edit it after);
// existing selling prices are never touched by a sync, so your pricing
// decisions always survive re-syncing.
router.post("/plans/sync", requireAdmin, async (req, res) => {
  const targets = [
    { network: "mtn", category: "gifting" },
    { network: "airtel", category: "gifting" },
    { network: "glo", category: "gifting" },
    { network: "glo", category: "sme" },
    { network: "9mobile", category: "gifting" },
    { network: "9mobile", category: "sme" },
  ];

  let created = 0;
  let updated = 0;
  const errors = [];

  for (const { network, category } of targets) {
    const serviceID = vtpass.getServiceId(network, category);
    if (!serviceID) continue;

    let variations;
    try {
      variations = await vtpass.fetchRawVariations(serviceID);
    } catch (err) {
      errors.push({ network, category, error: err.message });
      continue;
    }

    for (const v of variations) {
      const supplierPriceKobo = Math.round(parseFloat(v.variation_amount) * 100);
      const existing = await pool.query(
        "SELECT id, selling_price FROM data_plans WHERE vtpass_service_id = $1 AND vtpass_variation_code = $2",
        [serviceID, v.variation_code]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE data_plans
           SET supplier_price = $1, label = $2, network = $3, category = $4, updated_at = NOW()
           WHERE id = $5`,
          [supplierPriceKobo, v.name, network, category, existing.rows[0].id]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO data_plans
             (id, network, category, label, data_volume, validity, vtpass_service_id, vtpass_variation_code, supplier_price, selling_price, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, true)`,
          [uuid(), network, category, v.name, null, null, serviceID, v.variation_code, supplierPriceKobo]
        );
        created++;
      }
    }
  }

  res.json({ created, updated, errors });
});
// Separate sync for Haris Data — a second, often cheaper supplier alongside
// VTpass. Plans from this provider are tagged with supplier='harisdata' so
// purchase logic knows which API to call to fulfil them.
router.post("/plans/sync-harisdata", requireAdmin, async (req, res) => {
  let created = 0;
  let updated = 0;

  let plans;
  try {
    plans = await harisdata.fetchDataPlans();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  for (const p of plans) {
    const network = p._networkName || null;
    if (!network) continue;

    // Haris Data's "Type" field (mtnsme, mtngifting, mtncg, direct) becomes
    // our category. Anything not clearly SME gets treated as "gifting" so
    // it still shows up under a real tab in the app.
    const type = (p.Type || p.DataType || "").toLowerCase();
    const category = type.includes("sme") ? "sme" : "gifting";

    const supplierPriceKobo = Math.round(parseFloat(p.price || p["Your Price"] || 0) * 100);
    if (!supplierPriceKobo) continue;

    const planIdStr = String(p.PlanId || p.plan_id);
    const label = p.PlanName || p.plan_name || `Plan ${planIdStr}`;
    const validity = p.Validity || p.validity || null;

    const existing = await pool.query(
      "SELECT id FROM data_plans WHERE vtpass_service_id = 'harisdata' AND vtpass_variation_code = $1",
      [planIdStr]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE data_plans SET supplier_price = $1, label = $2, validity = $3, network = $4, category = $5, updated_at = NOW()
         WHERE id = $6`,
        [supplierPriceKobo, label, validity, network, category, existing.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO data_plans
           (id, network, category, label, data_volume, validity, vtpass_service_id, vtpass_variation_code, supplier_price, selling_price, active)
         VALUES ($1, $2, $3, $4, $5, $6, 'harisdata', $7, $8, $8, true)`,
        [uuid(), network, category, label, null, validity, planIdStr, supplierPriceKobo]
      );
      created++;
    }
  }

  res.json({ created, updated });
});
// Full list for the admin panel — includes supplier price and profit,
// which customer-facing routes never return.
router.get("/plans", requireAdmin, async (req, res) => {
  const { network, active } = req.query;
  const conditions = [];
  const params = [];

  if (network) {
    params.push(network);
    conditions.push(`network = $${params.length}`);
  }
  if (active !== undefined) {
    params.push(active === "true");
    conditions.push(`active = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT * FROM data_plans ${where} ORDER BY network, category, supplier_price`,
    params
  );

  const plans = result.rows.map((p) => ({
    id: p.id,
    network: p.network,
    category: p.category,
    label: p.label,
    data_volume: p.data_volume,
    validity: p.validity,
    vtpass_service_id: p.vtpass_service_id,
    vtpass_variation_code: p.vtpass_variation_code,
    supplier_price_naira: p.supplier_price / 100,
    selling_price_naira: p.selling_price / 100,
    profit_naira: (p.selling_price - p.supplier_price) / 100,
    active: p.active,
  }));

  res.json({ plans });
});

// Edit selling price, active status, data_volume/validity labels for one plan.
router.patch("/plans/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { selling_price_naira, active, data_volume, validity } = req.body;

  const existing = await pool.query("SELECT * FROM data_plans WHERE id = $1", [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: "Plan not found" });

  const updates = [];
  const params = [];

  if (selling_price_naira !== undefined) {
    if (selling_price_naira <= 0) return res.status(400).json({ error: "Selling price must be positive" });
    params.push(Math.round(selling_price_naira * 100));
    updates.push(`selling_price = $${params.length}`);
  }
  if (active !== undefined) {
    params.push(active);
    updates.push(`active = $${params.length}`);
  }
  if (data_volume !== undefined) {
    params.push(data_volume);
    updates.push(`data_volume = $${params.length}`);
  }
  if (validity !== undefined) {
    params.push(validity);
    updates.push(`validity = $${params.length}`);
  }

  if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });

  updates.push(`updated_at = NOW()`);
  params.push(id);
  await pool.query(`UPDATE data_plans SET ${updates.join(", ")} WHERE id = $${params.length}`, params);

  res.json({ ok: true });
});
// One-click way to hide every VTpass-sourced plan at once, keeping only
// Haris Data plans visible to customers — without deleting anything, so
// you can always flip VTpass plans back on later if needed.
router.post("/plans/deactivate-vtpass", requireAdmin, async (req, res) => {
  const result = await pool.query(
    "UPDATE data_plans SET active = false, updated_at = NOW() WHERE vtpass_service_id != 'harisdata' RETURNING id"
  );
  res.json({ deactivated: result.rows.length });
});
module.exports = router;
