// Print a receipt on the thermal printer at the office.
//
// The printer is Bluetooth and sits on a LAN this Worker cannot reach, so the
// job goes: browser -> here -> cloudflared tunnel -> a small relay on that LAN
// -> ESP32 BLE bridge -> printer. This module is only the middle hop.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// Inbound is session-authenticated: the route sits below the cookie gate in
// index.js, so `user` is already known.
//
// Outbound carries its own HMAC, the same scheme the shop uses to call
// /api/ingest/order (see ingest.js). The relay's hostname is public — anyone
// who finds it could otherwise print anything they liked on Aswin's printer,
// which is at best a paper-waster and at worst someone printing a fake receipt.

import { json, bad, hmacHex } from "./lib.js";

// One job is ~11s of printing, and the relay serialises them, so a second job
// waits behind the first. 45s covers a queued job without hanging a browser
// tab forever if the relay never answers.
const RELAY_TIMEOUT_MS = 45_000;

// Matches the client-side cap in index.js for emailed PDFs. A 57mm receipt is
// ~11KB of base64; this is generous while still bounding what we forward.
const MAX_PDF_B64 = 8_000_000;

// Send the signed job to the relay. Shaped like sendEmail() in lib.js:
// { ok: true } or { ok: false, status, error }, so the caller decides the HTTP
// status rather than this function throwing.
async function sendToRelay(env, raw) {
  const signature = await hmacHex(raw, env.PRINT_RELAY_SECRET);
  try {
    const r = await fetch(env.PRINT_RELAY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-print-signature": signature,
      },
      body: raw,                       // the exact bytes that were signed
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) {
      return { ok: false, status: r.status, error: d.error || `relay ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    // TimeoutError from AbortSignal, or a network failure reaching the tunnel.
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: timedOut
        ? "the printer did not respond in time"
        : `could not reach the printer: ${e?.message || e}`,
    };
  }
}

// Who is allowed to make paper come out of a machine in someone's house.
//
// Being signed in is NOT sufficient: magic-link signup is open (authRequest in
// index.js applies no allowlist, unlike the OAuth path), so anyone who can
// receive email could otherwise print here as often as they liked. This is a
// physical side effect in a private space, so it gets an explicit allowlist
// read from config — never from the request.
//
// Defaults to INVOICE_OWNER_EMAIL, which is already the "whose business is
// this" var, so a single-user deploy needs no extra configuration.
function mayPrint(env, email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return false;
  const list = String(env.PRINT_ALLOWED_EMAILS || env.INVOICE_OWNER_EMAIL || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(who);
}

export async function printReceipt(env, user, b) {
  // Kill switch first, so a disabled feature does no work and reaches nothing.
  if (String(env.PRINT_ENABLED ?? "").toLowerCase() !== "true") {
    return json({ error: "printing is disabled" }, 503);
  }

  if (!mayPrint(env, user.email)) {
    return json({ error: "this account cannot print" }, 403);
  }

  // Fail CLOSED, and with the same message as the kill switch: without the
  // secret or the URL there is nothing to sign or nowhere to send, and an
  // outsider should not be able to tell a misconfigured deploy from a
  // deliberately disabled one.
  if (!env.PRINT_RELAY_SECRET || !env.PRINT_RELAY_URL) {
    console.error("PRINT_RELAY_SECRET or PRINT_RELAY_URL is not set — refusing");
    return json({ error: "printing is disabled" }, 503);
  }

  const pdf = typeof b.pdfBase64 === "string" ? b.pdfBase64.trim() : "";
  if (!pdf || pdf.length > MAX_PDF_B64 || !/^[A-Za-z0-9+/=]+$/.test(pdf)) {
    return bad("a base64 PDF is required");
  }

  // Serialise ONCE. hmacHex signs a string, and the relay verifies the raw
  // bytes it receives — re-stringifying would produce different bytes and the
  // signature would never match. `ts` rides inside the signed body so it is
  // covered by the same signature and cannot be replayed with a fresh clock.
  const raw = JSON.stringify({
    pdfBase64: pdf,
    ts: Date.now(),
    by: user.email || "",
  });

  const res = await sendToRelay(env, raw);
  if (!res.ok) return json({ error: res.error }, res.status || 502);
  return json({ ok: true });
}
