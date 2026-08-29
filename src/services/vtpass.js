const fetch = require("node-fetch");

const BASE = process.env.VTPASS_BASE_URL || "https://sandbox.vtpass.com/api";

// VTpass's real, documented service IDs. Note: MTN and Airtel only expose
// ONE data service each ("gifting" style plans) — VTpass does not publicly
// document separate SME/Corporate endpoints for those two networks. Glo and
// 9mobile DO have genuine separate SME services, so those get two real tabs.
const SERVICE_IDS = {
  mtn: { gifting: "mtn-data" },
  airtel: { gifting: "airtel-data" },
  glo: { gifting: "glo-data", sme: "glo-sme-data" },
  "9mobile": { gifting: "etisalat-data", sme: "9mobile-sme-data" },
};

const AIRTIME_SERVICE_IDS = {
  mtn: "mtn",
  airtel: "airtel",
  glo: "glo",
  "9mobile": "etisalat",
};

// Which categories are real vs. not-yet-available per network — used by the
// frontend to grey out tabs that don't have a working VTpass service behind them.
const AVAILABLE_CATEGORIES = {
  mtn: ["gifting"],
  airtel: ["gifting"],
  glo: ["gifting", "sme"],
  "9mobile": ["gifting", "sme"],
};

const ALL_CATEGORIES = {
  mtn: ["sme", "gifting", "corporate"],
  airtel: ["corporate", "gifting"],
  glo: ["cg"],
  "9mobile": ["cg"],
};

function authHeaders() {
  return {
    "api-key": process.env.VTPASS_PUBLIC_KEY,
    "secret-key": process.env.VTPASS_SECRET_KEY,
    "Content-Type": "application/json",
  };
}

// Pulls the current live plan list + prices for a network + category.
async function getDataVariations(network, category = "gifting") {
  const serviceID = SERVICE_IDS[network]?.[category];
  if (!serviceID) return [];
  const res = await fetch(`${BASE}/service-variations?serviceID=${serviceID}`, {
    headers: { "api-key": process.env.VTPASS_PUBLIC_KEY },
  });
  const data = await res.json();
  return data?.content?.variations || data?.content?.varations || [];
}

function getServiceId(network, category = "gifting") {
  return SERVICE_IDS[network]?.[category];
}

// Buys a data bundle. requestId must be unique per attempt — VTpass uses it
// for idempotency on their side too, so retrying with the SAME requestId
// after a timeout is safe; retrying with a NEW one after a timeout can
// double-charge you.
async function buyData({ requestId, network, category = "gifting", phone, variationCode }) {
  const serviceID = getServiceId(network, category);
  const res = await fetch(`${BASE}/pay`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      request_id: requestId,
      serviceID,
      billersCode: phone,
      variation_code: variationCode,
      phone,
    }),
  });
  return res.json();
}

async function buyAirtime({ requestId, network, phone, amountNaira }) {
  const res = await fetch(`${BASE}/pay`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      request_id: requestId,
      serviceID: AIRTIME_SERVICE_IDS[network],
      billersCode: phone,
      amount: amountNaira,
      phone,
    }),
  });
  return res.json();
}

// VTpass responses use code "000" for success. Some failures only show up
// when you re-query, so always check requery for anything not immediately "000".
async function requeryTransaction(requestId) {
  const res = await fetch(`${BASE}/requery`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ request_id: requestId }),
  });
  return res.json();
}

module.exports = {
  getDataVariations,
  buyData,
  buyAirtime,
  requeryTransaction,
  getServiceId,
  SERVICE_IDS,
  AVAILABLE_CATEGORIES,
  ALL_CATEGORIES,
};
