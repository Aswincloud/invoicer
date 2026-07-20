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

// ── Resend email (NOTE: User-Agent header is REQUIRED or Resend 403s /1010) ──
export async function sendEmail(env, { to, subject, html, text }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "invoicer/1.0 (+cloudflare-worker)",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || "notify@aswincloud.com",
      to: Array.isArray(to) ? to : [to],
      subject, html, text,
    }),
  });
  if (r.ok) return { ok: true, id: (await r.json().catch(() => ({}))).id };
  return { ok: false, status: r.status, error: await r.text().catch(() => "") };
}

export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || "");
