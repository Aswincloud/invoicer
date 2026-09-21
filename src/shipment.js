/* Shipments on an invoice: the courier and tracking number, the two WhatsApp
 * updates about them, live status from ShipTrack, and the lookup the support
 * bot uses when a customer asks "where is my parcel?" on WhatsApp.
 *
 * Why this lives on the invoice: a customer who paid Aswin directly has no shop
 * order anywhere. The invoice is the order record, it already carries the
 * customer's phone, and it is what Aswin reopens to say "shipped".
 *
 * ── The security rule for the bot lookup ─────────────────────────────────────
 *
 * Same one as the shop's chat order lookup. The LLM supplies NEITHER the caller
 * nor the identity:
 *
 *   - THAT THE CALLER IS THE BOT: HMAC-SHA256 over the raw body with
 *     INVOICER_CHAT_SECRET, plus a timestamp, so a captured request is not a
 *     permanent read of someone's shipments.
 *   - WHICH CUSTOMER: the phone number Meta verified as the WhatsApp sender,
 *     read by the bot off the Chatwoot contact. Nobody types it.
 *
 * Invoicer has many accounts. Every query here is scoped to the ONE owner named
 * in INVOICE_OWNER_EMAIL, read from config and never from the request, so this
 * endpoint cannot be pointed at another user's invoices however it is called.
 */

import { json, bad, now, hmacHex, timingSafeEqualHex } from "./lib.js";
import { WA_ENV, toE164, waConfigured, sendTemplate } from "./wa.js";

/* ShipTrack's carriers. Ids are what its API and /track/ links take; names are
 * what goes into the customer's message. Kept in step with
 * https://shiptrack.aswincloud.com/api/carriers by hand — it changes rarely, and
 * a dropdown must not depend on a network call to render. */
export const CARRIERS = [
  { id: "bluedart",   name: "Blue Dart" },
  { id: "delhivery",  name: "Delhivery" },
  { id: "shiprocket", name: "Shiprocket" },
  { id: "stcourier",  name: "ST Courier" },
  { id: "tpc",        name: "The Professional Couriers" },
];

export const carrierName = (id) =>
  (CARRIERS.find((c) => c.id === String(id || "").toLowerCase()) || {}).name || "";

export const isCarrier = (id) => CARRIERS.some((c) => c.id === String(id || "").toLowerCase());

/* A tracking number as typed by a person: spaces and stray punctuation gone,
 * upper-cased. Anything outside 4..40 chars of letters/digits/dash is refused
 * rather than sent to a courier as-is. */
export function normalizeAwb(raw) {
  const s = String(raw ?? "").trim().toUpperCase().replace(/[\s.]/g, "");
  if (!/^[A-Z0-9-]{4,40}$/.test(s)) return "";
  return s;
}

const shiptrackBase = (env) =>
  String(env.SHIPTRACK_BASE_URL || "https://shiptrack.aswincloud.com").replace(/\/+$/, "");

/* The link a customer can open. */
export const trackUrl = (env, carrier, awb) =>
  carrier && awb
    ? `${shiptrackBase(env)}/track/${encodeURIComponent(carrier)}/${encodeURIComponent(awb)}`
    : "";

/* Live status from ShipTrack's public API. Never throws. Returns
 *   { ok:true, status, eta, lastEvent:{description,location,timestamp}, fetchedAt }
 * or { ok:false, error } where error is ShipTrack's own code when it gave one
 * ("not_found", "rate_limited", "upstream_error", "invalid_input") so callers can
 * tell "the courier does not know this number" from "ShipTrack is down". */
export async function trackShipment(env, carrier, awb, { timeoutMs = 8000 } = {}) {
  if (!isCarrier(carrier) || !awb) return { ok: false, error: "invalid_input" };
  const url = `${shiptrackBase(env)}/api/track/${encodeURIComponent(carrier)}/${encodeURIComponent(awb)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": "invoicer-shipment/1.0" }, signal: ctrl.signal });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d.error || `http_${r.status}`, message: d.message || "" };
    const events = Array.isArray(d.events) ? d.events : [];
    const last = events.length
      ? events.reduce((a, b) => (String(a.timestamp) > String(b.timestamp) ? a : b))
      : null;
    return {
      ok: true,
      status: String(d.status || "unknown"),
      eta: d.estimatedDelivery || null,
      lastEvent: last ? { description: last.description || "", location: last.location || "", timestamp: last.timestamp || "" } : null,
      fetchedAt: d.fetchedAt || new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : "network", message: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export const isDelivered = (track) => !!(track && track.ok && track.status === "delivered");

/* Epoch ms for "when was it delivered", from the courier's own event time when
 * there is one, else now. A date on the message should be the courier's. */
export function deliveredAtFrom(track) {
  const ts = track && track.lastEvent && track.lastEvent.timestamp;
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : now();
}

// ── the two follow-up templates ───────────────────────────────────
//
// Both mirror templates that already exist on the WABA. The placeholder ORDER
// below is the template's, so the params here must stay in this order:
//
//   order_shipped_link   Hi {{1}}, good news! 🎉 Your order {{2}} from {{3}} has
//                        been shipped via {{4}}. 📦 Tracking ID: {{5}} You can
//                        track your package using the button below.
//                        + a dynamic URL button, see shippedButtonParam.
//   order_delivered_new  Hi {{1}}, your order {{2}} from {{3}} has been
//                        delivered successfully. 🎉 ...
//
// The shipped template carries the tracking LINK as its URL button; the
// delivered one has no button.

const tplShipped   = (env) => env.WA_TEMPLATE_SHIPPED   || "order_shipped_link";
const tplDelivered = (env) => env.WA_TEMPLATE_DELIVERED || "order_delivered_new";
const lang = (env) => env[WA_ENV.lang] || "en";

/* A Meta URL button is a FIXED prefix set on the template plus one dynamic
 * suffix sent per message. order_shipped_link's button is
 *
 *   https://shiptrack.aswincloud.com/track/{{1}}
 *
 * so the suffix is "<carrier>/<awb>" — NOT "track/<carrier>/<awb>", which
 * produced .../track/track/bluedart/... once. If the template is ever
 * recreated with a different prefix, set WA_SHIPPED_BUTTON_BASE to that
 * prefix (with its trailing slash) and the suffix follows. A prefix that is
 * not a prefix of the link at all sends the whole link, which Meta will show
 * doubled - that is the visible failure. */
const shippedButtonBase = (env) =>
  String(env.WA_SHIPPED_BUTTON_BASE || `${shiptrackBase(env)}/track/`);

export function shippedButtonParam(env, courier, awb) {
  const url = trackUrl(env, courier, awb);
  const base = shippedButtonBase(env);
  return url.startsWith(base) ? url.slice(base.length) : url;
}

const who = (inv) => String(inv.client_name || "").trim() || "there";
const biz = (inv) => String(inv.biz_name || "").trim() || "us";

export function shippedParams(inv, courier, awb) {
  return [who(inv), String(inv.number || ""), biz(inv), carrierName(courier) || String(courier || ""), String(awb || "")];
}
export function deliveredParams(inv) {
  return [who(inv), String(inv.number || ""), biz(inv)];
}

const bodyComponent = (params) => ({
  type: "body",
  parameters: params.map((text) => ({ type: "text", text })),
});

export function buildShippedMessage(env, { to, inv, courier, awb }) {
  return {
    messaging_product: "whatsapp", to, type: "template",
    template: { name: tplShipped(env), language: { code: lang(env) },
                components: [
                  bodyComponent(shippedParams(inv, courier, awb)),
                  // The template's one URL button, index 0.
                  { type: "button", sub_type: "url", index: "0",
                    parameters: [{ type: "text", text: shippedButtonParam(env, courier, awb) }] },
                ] },
  };
}

export function buildDeliveredMessage(env, { to, inv }) {
  return {
    messaging_product: "whatsapp", to, type: "template",
    template: { name: tplDelivered(env), language: { code: lang(env) },
                components: [bodyComponent(deliveredParams(inv))] },
  };
}

/* The message as the customer will read it, for the confirmation preview.
 *
 * This is the template TEXT with the same params the send uses substituted in,
 * so what the preview shows is what goes out. If a template is edited in Meta
 * Business Manager, edit the matching string here too — Meta only ever sends
 * its own copy, so a drift shows in the preview, never in the message.
 *
 * Copied from Meta Business Manager on 20 Sep 2026. None of the three has a
 * header or footer; `button` is the shipped template's URL button, shown in
 * the preview with the link it will open. */
const TEMPLATE_TEXT = {
  invoice: {
    body: "Hi {{1}}, thank you for your order! 🎉 Your order {{2}} from {{3}} has been confirmed successfully. We’ll let you know once your order has been shipped. Thank you for shopping with us! ❤️",
  },
  shipped: {
    body: "Hi {{1}}, good news! 🎉 Your order {{2}} from {{3}} has been shipped via {{4}}. 📦 Tracking ID: {{5}} You can track your package using the button below.",
    button: "Track your package",
  },
  delivered: {
    body: "Hi {{1}}, your order {{2}} from {{3}} has been delivered successfully. 🎉 We hope you enjoy your purchase! Thank you for shopping with us. ❤️",
  },
};

export function previewText(kind, params, { buttonUrl = "" } = {}) {
  const t = TEMPLATE_TEXT[kind];
  if (!t) return "";
  const body = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => String(params[Number(n) - 1] ?? ""));
  return t.button ? `${body}\n\n[ ${t.button} ] → ${buttonUrl}` : body;
}

// ── the owner ─────────────────────────────────────────────────────

/* The one account whose invoices the bot may read, and whose parcels the cron
 * follows. From config, never from a request (see the header). */
export async function ownerUser(env) {
  const email = String(env.INVOICE_OWNER_EMAIL || "").trim().toLowerCase();
  if (!email) return null;
  return env.DB.prepare("SELECT * FROM users WHERE lower(email)=?").bind(email).first();
}

// ── bot lookup: POST /api/chat/shipments ──────────────────────────

const MAX_SHIPMENTS = 5;
const MAX_SKEW_MS = 5 * 60 * 1000;     // matches the shop's chat endpoints
const LOOKBACK_MS = 120 * 24 * 60 * 60 * 1000;

/* Verifying a quoted invoice when the phone does not match.
 *
 * The customer quoted a number, but the message came from a phone that is not
 * on that invoice (or the invoice has none). The number alone proves little —
 * they are guessable — so the customer is asked for something printed on the
 * document they hold: the name it is billed to, the amount, or the business
 * that billed them. Any one matching is enough. The comparison happens HERE,
 * on what the customer typed (`hints`), never in the model.
 *
 * Returns which field matched ("name" | "amount" | "biller") or "". */
const normText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export function amountsIn(text) {
  // "₹1,299.00", "1299", "Rs 350" -> [1299, 350]. Digits-with-separators only.
  return [...String(text || "").matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

export function hintMatches(inv, hints) {
  const texts = (Array.isArray(hints) ? hints : []).map((h) => String(h || "")).filter(Boolean);
  if (!texts.length) return "";
  const joined = texts.join(" \n ");
  const normJoined = normText(joined);

  // Name: the full billed-to name, or its first word when that is 3+ letters
  // ("Vennila" for "Vennila R"). Two letters would match half the alphabet.
  const name = normText(inv.client_name);
  const first = normText(String(inv.client_name || "").trim().split(/\s+/)[0]);
  if (name.length >= 3 && normJoined.includes(name)) return "name";
  if (first.length >= 3 && normJoined.includes(first)) return "name";

  // Amount: the invoice total, to the rupee or exactly. "350" matches 350.00.
  const total = Number(inv.total);
  if (Number.isFinite(total) && total > 0) {
    for (const n of amountsIn(joined)) {
      if (Math.abs(n - total) < 0.005 || Math.round(n) === Math.round(total)) return "amount";
    }
  }

  // Biller: the business name on the invoice ("Aswin 3D Prints" == "Aswin3DPrints").
  const biz = normText(inv.biz_name);
  if (biz.length >= 4 && normJoined.includes(biz)) return "biller";
  return "";
}

export async function chatShipmentsHandler(request, env) {
  // Fails CLOSED: without the secret nothing here can tell the bot from anyone.
  if (!env.INVOICER_CHAT_SECRET) {
    console.error("chat shipments lookup is not configured — refusing");
    return json({ error: "unavailable" }, 503);
  }
  const raw = await request.text();
  const signature = request.headers.get("x-chat-signature") || "";
  if (!signature) return bad("unauthorized", 401);
  const expected = await hmacHex(raw, env.INVOICER_CHAT_SECRET);
  if (!timingSafeEqualHex(expected, signature)) return bad("unauthorized", 401);

  let body;
  try { body = JSON.parse(raw); } catch { return bad("invalid json"); }
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > MAX_SKEW_MS) return bad("stale", 401);

  const phone = toE164(body.phone);
  // Invoice numbers the customer quoted in the chat, if any. Normalised the
  // way they are printed: upper-case, no spaces.
  const quoted = [...new Set((Array.isArray(body.numbers) ? body.numbers : [])
    .map((n) => String(n || "").toUpperCase().replace(/\s+/g, "").trim())
    .filter((n) => /^[A-Z0-9][A-Z0-9-]{3,39}$/.test(n)))].slice(0, 3);
  // What the customer has typed recently — compared against a quoted invoice
  // when the phone does not match it. Strings, capped, never interpreted.
  const hints = (Array.isArray(body.hints) ? body.hints : [])
    .map((h) => String(h || "").slice(0, 200)).filter(Boolean).slice(0, 8);
  if (!phone && !quoted.length) return json({ shipments: [], pending_verification: [] });

  const owner = await ownerUser(env);
  if (!owner) return json({ shipments: [], pending_verification: [] });

  // Two ways in, one rule about who may see what:
  //
  //   by phone   the sender's own invoices — Meta verified the phone, so this
  //              is the customer's own information. Shared at once.
  //   by number  an invoice the customer quoted from a phone that is not on it
  //              (or it has none). Shared only once something printed on the
  //              invoice has been confirmed — the billed-to name, the amount or
  //              the biller — see hintMatches. Until then the reply carries
  //              the number under pending_verification with what to ask for,
  //              and no details.
  const params = [owner.id];
  const where = [];
  if (phone) { where.push("client_phone = ?"); params.push(phone); }
  if (quoted.length) { where.push(`number IN (${quoted.map(() => "?").join(",")})`); params.push(...quoted); }

  // Placeholders bind in textual order: WHERE (owner, phone, numbers),
  // created_at, then the ORDER BY's copy of the numbers, then LIMIT.
  const { results } = await env.DB.prepare(
    `SELECT id, number, status, currency, total, courier, tracking_id, shipped_at, delivered_at,
            track_status, track_checked_at, paid_at, created_at, client_phone, client_name, business_id
       FROM invoices
      WHERE user_id = ? AND (${where.join(" OR ")}) AND status <> 'VOID'
        AND (status = 'PAID' OR shipped_at IS NOT NULL)
        AND created_at > ?
      ORDER BY (number IN (${quoted.length ? quoted.map(() => "?").join(",") : "''"})) DESC, created_at DESC LIMIT ?`
  ).bind(...params, now() - LOOKBACK_MS, ...quoted, MAX_SHIPMENTS + 3).all();

  // Business names, for the biller check and for the message.
  const bizRows = (await env.DB.prepare(
    "SELECT id, biz_name, is_default FROM businesses WHERE user_id = ?"
  ).bind(owner.id).all().catch(() => ({ results: [] }))).results || [];
  const bizName = (id) => (bizRows.find((b) => b.id === id) || bizRows.find((b) => b.is_default) || {}).biz_name || "";

  const rows = [];
  const pending = [];
  for (const r of results || []) {
    r.biz_name = bizName(r.business_id);
    if (phone && r.client_phone === phone) { rows.push(r); continue; }
    // Quoted from another phone (or none on file): needs one printed detail.
    const how = hintMatches(r, hints);
    if (how) {
      console.log(JSON.stringify({ msg: "chat shipments: quoted invoice verified", number: r.number, by: how }));
      rows.push(r);
    } else {
      const needs = [];
      if (normText(r.client_name).length >= 3) needs.push("name");
      if (Number(r.total) > 0) needs.push("amount");
      if (normText(r.biz_name).length >= 4) needs.push("biller");
      pending.push({ number: r.number, needs });
    }
  }
  rows.splice(MAX_SHIPMENTS);
  let items = {};
  if (rows.length) {
    const ph = rows.map(() => "?").join(",");
    const li = await env.DB.prepare(
      `SELECT invoice_id, description FROM line_items WHERE invoice_id IN (${ph}) ORDER BY pos`
    ).bind(...rows.map((r) => r.id)).all();
    for (const l of li.results || []) (items[l.invoice_id] ||= []).push(l.description);
  }

  return json({
    pending_verification: pending,
    shipments: rows.map((r) => ({
      number: r.number,
      status: r.status,
      total: r.total,
      currency: r.currency,
      biz_name: r.biz_name || null,
      items: (items[r.id] || []).slice(0, 4),
      courier: r.courier || null,
      courier_name: carrierName(r.courier) || null,
      tracking_id: r.tracking_id || null,
      shipped_at: r.shipped_at || null,
      delivered_at: r.delivered_at || null,
      track_status: r.track_status || null,
      track_checked_at: r.track_checked_at || null,
      track_url: trackUrl(env, r.courier, r.tracking_id) || null,
    })),
  });
}

// ── cron: notice deliveries and say so ────────────────────────────

const CRON_BATCH = 25;
const IN_TRANSIT_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/* Every run: for each invoice shipped but not yet delivered, ask ShipTrack.
 * Record what it said; when it says delivered, stamp the invoice and send the
 * customer the delivered template — once, guarded by wa_delivered_at.
 *
 * Never throws. A courier site being down must not take the cron with it; the
 * next run tries again. */
export async function checkDeliveries(env) {
  const summary = { checked: 0, delivered: 0, notified: 0, errors: 0 };
  const owner = await ownerUser(env);
  if (!owner) return summary;

  const { results } = await env.DB.prepare(
    `SELECT * FROM invoices
      WHERE user_id = ? AND shipped_at IS NOT NULL AND delivered_at IS NULL
        AND courier <> '' AND tracking_id <> '' AND shipped_at > ?
      ORDER BY track_checked_at ASC NULLS FIRST LIMIT ?`
  ).bind(owner.id, now() - IN_TRANSIT_WINDOW_MS, CRON_BATCH).all();

  for (const inv of results || []) {
    summary.checked++;
    const track = await trackShipment(env, inv.courier, inv.tracking_id);
    const t = now();
    if (!track.ok) {
      summary.errors++;
      // Not-found and invalid-input are facts about the number, worth keeping;
      // network and rate limits are not, and must not overwrite a good status.
      if (track.error === "not_found" || track.error === "invalid_input") {
        await env.DB.prepare("UPDATE invoices SET track_status=?, track_checked_at=? WHERE id=?")
          .bind(track.error, t, inv.id).run();
      }
      continue;
    }
    if (!isDelivered(track)) {
      await env.DB.prepare("UPDATE invoices SET track_status=?, track_checked_at=? WHERE id=?")
        .bind(track.status, t, inv.id).run();
      continue;
    }

    summary.delivered++;
    const deliveredAt = deliveredAtFrom(track);
    await env.DB.prepare(
      "UPDATE invoices SET delivered_at=?, track_status='delivered', track_checked_at=?, updated_at=? WHERE id=?"
    ).bind(deliveredAt, t, t, inv.id).run();

    if (inv.wa_delivered_at || !inv.client_phone || !waConfigured(env)) continue;
    // biz_name is needed for {{3}}; the raw invoice row does not carry it. The
    // column is biz_name, not name - this once read `SELECT name`, which throws
    // "no such column", was swallowed by the catch, and sent every automatic
    // delivered message as "from us". Falls back to the account default business
    // for rows raised before business_id existed.
    const b = await env.DB.prepare(
      inv.business_id
        ? "SELECT biz_name FROM businesses WHERE id=?"
        : "SELECT biz_name FROM businesses WHERE user_id=? ORDER BY is_default DESC, created_at ASC LIMIT 1"
    ).bind(inv.business_id || inv.user_id).first().catch((e) => {
      console.error("business lookup failed", inv.number, String(e?.message || e));
      return null;
    });
    const msg = buildDeliveredMessage(env, { to: inv.client_phone, inv: { ...inv, biz_name: b?.biz_name || inv.biz_name } });
    const res = await sendTemplate(env, msg);
    if (!res.ok) {
      summary.errors++;
      console.error("delivered message failed", inv.number, res.status, res.error);
      continue;
    }
    summary.notified++;
    await env.DB.prepare(
      "UPDATE invoices SET wa_delivered_message_id=?, wa_delivered_at=?, updated_at=? WHERE id=?"
    ).bind(res.id, now(), now(), inv.id).run();
  }
  console.log(JSON.stringify({ msg: "checkDeliveries", ...summary }));
  return summary;
}
