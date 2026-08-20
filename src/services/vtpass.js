const fetch = require("node-fetch");

const BASE = process.env.VTPASS_BASE_URL || "https://sandbox.vtpass.com/api";

// VTpass identifies each network as a "serviceID". These are their fixed codes.
const SERVICE_IDS = {
  mtn: "mtn-data",
  airtel: "airtel-data",
  glo: "glo-data",
  "9mobile": "etisalat-data",
};

const AIRTIME_SERVICE_IDS = {
  mtn: "mtn",
  airtel: "airtel",
  glo: "glo",
  "9mobile": "etisalat",
};

function authHeaders() {
  return {
    "api-key": process.env.VTPASS_PUBLIC_KEY,
    "secret-key": process.env.VTPASS_SECRET_KEY,
    "Content-Type": "application/json",
  };
}

// Pulls the current live plan list + prices for a network. Call this instead
// of hardcoding prices in the frontend — VTpass prices change, and your
// cost price (what you're charged) has to match what you query, or purchases
// will fail on amount mismatch.
async function getDataVariations(network) {
  const serviceID = SERVICE_IDS[network];
  const res = await fetch(`${BASE}/service-variations?serviceID=${serviceID}`, {
    headers: { "api-key": process.env.VTPASS_PUBLIC_KEY },
  });
  const data = await res.json();
  return data?.content?.variations || [];
}

// Buys a data bundle. requestId must be unique per attempt — VTpass uses it
// for idempotency on their side too, so retrying with the SAME requestId
// after a timeout is safe; retrying with a NEW one after a timeout can
// double-charge you.
async function buyData({ requestId, network, phone, variationCode }) {
  const res = await fetch(`${BASE}/pay`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      request_id: requestId,
      serviceID: SERVICE_IDS[network],
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

module.exports = { getDataVariations, buyData, buyAirtime, requeryTransaction, SERVICE_IDS };
