// Shared helpers: JSON responses, ids, HMAC signing, cookies, Resend email.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const bad = (msg, status = 400) => json({ error: msg }, status);

export const uid = () => crypto.randomUUID();

// short random token for magic links / session ids
export function randToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const now = () => Date.now();

// ── HMAC-SHA256 signing (for tamper-proof session cookie) ─────────
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function sign(value, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${value}.${b64}`;
}
export async function unsign(signed, secret) {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = await sign(value, secret);
  // constant-time-ish compare
  if (expected.length !== signed.length) return null;
  let diff = 0;
  for (let j = 0; j < expected.length; j++) diff |= expected.charCodeAt(j) ^ signed.charCodeAt(j);
  return diff === 0 ? value : null;
}

// Hex digest, for verifying signatures produced by another service.
//
// Separate from sign()/unsign() above, which are base64url and carry the signed
// value inline — a cookie format, not a webhook one. A caller signing a request
// body sends the digest in a header, so hex is what it needs, and the two must
// not be confused: verifying a body against sign() would silently never match.
//
// Same shape as the shop's src/lib.js, deliberately — the shop already signs its
// Razorpay webhooks and chat-coupon calls this way, and one scheme across both
// services is one thing to get right instead of two.
export async function hmacHex(message, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare of two hex digests. Length is compared first and is not
// secret (a SHA-256 digest is always 64 chars), so returning early there leaks
// nothing an attacker could not already work out.
export function timingSafeEqualHex(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ── cookies ───────────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  const h = req.headers.get("cookie") || "";
  h.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
export function cookie(name, value, { maxAge = 60 * 60 * 24 * 30, del = false } = {}) {
  const parts = [
    `${name}=${del ? "" : encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax",
    `Max-Age=${del ? 0 : maxAge}`,
  ];
  return parts.join("; ");
}

// Build a Resend `from` header. The verified address is fixed (RESEND_FROM_EMAIL);
// only the display name varies. Strip characters that could break the header or
// smuggle a second address (quotes, angle brackets, commas, newlines).
function fromHeader(env, name) {
  const addr = env.RESEND_FROM_EMAIL || "notify@aswincloud.com";
  const clean = String(name || "").replace(/[<>",;\r\n]/g, " ").trim().slice(0, 78);
  return clean ? `${clean} <${addr}>` : addr;
}

// ── Resend email (NOTE: User-Agent header is REQUIRED or Resend 403s /1010) ──
// `fromName` is an optional display name; `attachments` is an optional array of
// { filename, content } where content is base64 (Resend's attachment format).
export async function sendEmail(env, { to, subject, html, text, fromName, attachments }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };
  const payload = {
    from: fromHeader(env, fromName),
    to: Array.isArray(to) ? to : [to],
    subject, html, text,
  };
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "invoicer/1.0 (+cloudflare-worker)",
    },
    body: JSON.stringify(payload),
  });
  if (r.ok) return { ok: true, id: (await r.json().catch(() => ({}))).id };
  return { ok: false, status: r.status, error: await r.text().catch(() => "") };
}

export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || "");
