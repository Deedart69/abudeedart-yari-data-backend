const fetch = require("node-fetch");

const BASE = process.env.VTPASS_BASE_URL || "https://sandbox.vtpass.com/api";

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

function getServiceId(network, category = "gifting") {
  const key = category === "cg" ? "sme" : category;
  return SERVICE_IDS[network]?.[key];
}

async function fetchRawVariations(serviceID) {
  const res = await fetch(`${BASE}/service-variations?serviceID=${serviceID}`, {
    headers: { "api-key": process.env.VTPASS_PUBLIC_KEY },
  });
  const data = await res.json();
  return data?.content?.variations || data?.content?.varations || [];
}

async function getDataVariations(network, category = "gifting") {
  const serviceID = getServiceId(network, category);
  if (!serviceID) return [];
  return fetchRawVariations(serviceID);
}

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

async function payExact({ requestId, serviceID, variationCode, phone }) {
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

async function requeryTransaction(requestId) {
  const res = await fetch(`${BASE}/requery`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ request_id: requestId }),
  });
  return res.json();
}

module.exports = {
  fetchRawVariations,
  getDataVariations,
  buyData,
  buyAirtime,
  payExact,
  requeryTransaction,
  getServiceId,
  SERVICE_IDS,
  AVAILABLE_CATEGORIES,
  ALL_CATEGORIES,
};
