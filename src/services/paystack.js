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

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature };
