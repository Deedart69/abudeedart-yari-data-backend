const fetch = require("node-fetch");
const crypto = require("crypto");

const BASE = "https://api.paystack.co";

// Step 1 of funding a wallet: ask Paystack for a checkout link.
// amountKobo must be an integer (Paystack works in kobo, same as our ledger).
async function initializeTransaction({ email, amountKobo, reference, callbackUrl }) {
  const res = await fetch(`${BASE}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      callback_url: callbackUrl,
    }),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Paystack initialize failed");
  return data.data; // { authorization_url, access_code, reference }
}

// Step 2: after payment, confirm with Paystack directly — never trust the
// frontend's "payment succeeded" message on its own.
async function verifyTransaction(reference) {
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Paystack verify failed");
  return data.data; // { status: 'success'|'failed', amount, reference, ... }
}

// Confirms a webhook body actually came from Paystack, not a forged request.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}


// Step 1 of getting a dedicated account: register the user as a Paystack
// Customer. Returns a customer_code we need for the next step.
async function createCustomer({ email, firstName, lastName, phone }) {
  const res = await fetch(`${BASE}/customer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      first_name: firstName,
      last_name: lastName,
      phone,
    }),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Paystack customer creation failed");
  return data.data; // includes customer_code
}

// Step 2: request a Dedicated Virtual Account for that customer. This call
// itself doesn't return finished account details — the actual account
// number arrives moments later via Paystack's webhook (event:
// "dedicatedaccount.assign.success"), since bank account provisioning is
// asynchronous on their end.
async function createDedicatedAccount({ customerCode, preferredBank = "wema-bank" }) {
  const res = await fetch(`${BASE}/dedicated_account`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer: customerCode,
      preferred_bank: preferredBank,
    }),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Dedicated account request failed");
  return data.data;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  createCustomer,
  createDedicatedAccount,
};
