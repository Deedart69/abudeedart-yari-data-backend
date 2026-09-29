const fetch = require("node-fetch");

const BASE = "https://harisdata.com.ng";

function authHeaders() {
  return {
    Authorization: `Token ${process.env.HARISDATA_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// Network name -> Haris Data's numeric network ID (from their docs' reference table)
const NETWORK_IDS = {
  mtn: 1,
  glo: 2,
  "9mobile": 3,
  airtel: 4,
};

// Fetches the live plan list, priced for your account tier. Returns Haris
// Data's raw plan objects (PlanId, PlanName, price, Type, Validity, etc.)
// so the admin sync can decide how to store/categorize them.
async function fetchDataPlans() {
  const res = await fetch(`${BASE}/api/data/data_plan.php`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    // TEMPORARY: surfaces the raw response so we can see exactly what
    // Haris Data sent back (e.g. an HTML error page instead of JSON).
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
  }
  if (data.success !== "1" && data.status !== "success") {
    // TEMPORARY: include the full response for debugging the auth issue.
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data.plans || [];
}

// Buys a data plan using Haris Data's numeric plan ID (stored as
// vtpass_variation_code in your data_plans table for this provider, for
// simplicity — despite the column name, it just holds "the code the
// supplier needs to fulfil this exact plan").
async function buyData({ network, phone, planId }) {
  const networkId = NETWORK_IDS[network];
  const res = await fetch(`${BASE}/api/data/`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      network: networkId,
      phone,
      data_plan: planId,
    }),
  });
  return res.json();
}

module.exports = { fetchDataPlans, buyData, NETWORK_IDS };
