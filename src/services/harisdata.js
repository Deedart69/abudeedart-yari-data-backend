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
    headers: authHeaders(),
  });
  const data = await res.json();
  if (data.success !== "1" && data.status !== "success") {
    throw new Error(data.msg || data.error || "Failed to fetch Haris Data plans");
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
