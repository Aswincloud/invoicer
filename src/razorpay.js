// Razorpay REST client + signature verification.
//
// Ported from the shop (3d_printing/src/razorpay.js), which has been running
// this code against live payments. Kept as a near-copy on purpose: the two
// Workers talk to the same Razorpay account, and a subtly different client here
// would be a subtly different bug surface for the same API.
//
// No `razorpay` npm SDK: it does `require("crypto")` and ships axios's Node HTTP
// adapter, so it fails to bundle for a Worker without `nodejs_compat`. The REST
// API is a couple of endpoints; fetch + WebCrypto covers it.

import { hmacHex, timingSafeEqualHex } from "./lib.js";

const API = "https://api.razorpay.com/v1";

// Razorpay authenticates with HTTP Basic: key_id as user, key_secret as pass.
// btoa is fine here — no Buffer without nodejs_compat.
function authHeader(env) {
  return "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
}

// Feature-flag by secret presence, the way the print and ingest paths do. Missing
// keys disable paying with a clear message instead of 500-ing at the API call.
export function paymentsConfigured(env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

// Only the key *id* is public — it goes to the browser to open Checkout.
// KEY_SECRET never leaves the Worker.
export const publicKeyId = (env) => env.RAZORPAY_KEY_ID || "";

// ── orders ────────────────────────────────────────────────────────
// `amountPaise` is computed server-side from the stored invoice. Nothing the
// browser sends reaches this function.
export async function createOrder(env, { amountPaise, receipt, notes }) {
  // Razorpay's own floor; the API rejects <100 outright, so fail before the
  // round-trip rather than surfacing their error to a client.
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    return { ok: false, status: 400, error: "Amount must be at least ₹1." };
  }

  const r = await fetch(`${API}/orders`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: String(receipt).slice(0, 40),   // Razorpay caps receipt at 40 chars
      notes: notes || {},
    }),
  });

  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const desc = body?.error?.description || "";
    return { ok: false, status: r.status, error: desc, body };
  }
  return { ok: true, order: body };
}

export async function fetchPayment(env, paymentId) {
  const r = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authHeader(env) },
  });
  const body = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, payment: body } : { ok: false, status: r.status, body };
}

// ── signatures ────────────────────────────────────────────────────
// TWO DIFFERENT SECRETS, and mixing them up is the classic Razorpay bug:
//
//   checkout callback → HMAC(order_id|payment_id, KEY_SECRET)
//   webhook           → HMAC(raw_request_body,    WEBHOOK_SECRET)
//
// KEY_SECRET is the API password. WEBHOOK_SECRET is a separate string typed into
// the dashboard when creating the webhook. They are never the same value.

export async function verifyCallbackSignature(env, { orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  const expected = await hmacHex(`${orderId}|${paymentId}`, env.RAZORPAY_KEY_SECRET);
  return timingSafeEqualHex(expected, signature);
}

// `rawBody` must be the exact bytes received — re-serialising parsed JSON
// changes them and verification fails.
export async function verifyWebhookSignature(env, rawBody, signature) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = await hmacHex(rawBody, secret);
  return timingSafeEqualHex(expected, signature);
}
