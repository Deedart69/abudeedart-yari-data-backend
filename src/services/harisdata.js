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

// Haris Data's plan-listing endpoint wants a specific network per request
// (confirmed by their own "Network Id Required" error), so we call it once
// per network and merge the results.
async function fetchDataPlans() {
  const allPlans = [];
  for (const [networkName, networkId] of Object.entries(NETWORK_IDS)) {
    const res = await fetch(`${BASE}/api/data/data_plan.php`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ NetworkId: networkId }),
    });
    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`Non-JSON response for ${networkName} (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
    }
    if (data.success !== "1" && data.status !== "success") {
      throw new Error(`${networkName}: ${JSON.stringify(data)}`);
    }
    for (const plan of data.plans || []) {
      allPlans.push({ ...plan, _networkName: networkName });
    }
  }
  return allPlans;
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


async function buyAirtime({ network, phone, amountNaira }) {
  const networkId = NETWORK_IDS[network];
  const res = await fetch(`${BASE}/api/airtime/`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      network: networkId,
      phone,
      amount: amountNaira,
    }),
  });
  return res.json();
}

module.exports = { fetchDataPlans, buyData, buyAirtime, NETWORK_IDS };
