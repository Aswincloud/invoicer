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
//   order_shipped   Hi {{1}}, good news — your order {{2}} from {{3}} has shipped
//                   via {{4}}. Tracking ID: {{5}}. ...
//   order_delivered Hi {{1}}, your order {{2}} from {{3}} has been delivered. ...
//
// Neither template has a URL button, so the tracking LINK is not in the message
// — only courier and number. The bot hands out the link when asked.

const tplShipped   = (env) => env.WA_TEMPLATE_SHIPPED   || "order_shipped";
const tplDelivered = (env) => env.WA_TEMPLATE_DELIVERED || "order_delivered";
const lang = (env) => env[WA_ENV.lang] || "en";

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
                components: [bodyComponent(shippedParams(inv, courier, awb))] },
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
 * its own copy, so a drift shows in the preview, never in the message. */
const TEMPLATE_TEXT = {
  invoice: {
    header: "📄 (invoice PDF attached)",
    body: "Hi {{1}}, thank you for your payment! Your order {{2}} for {{3}} from {{4}} is confirmed and the invoice is attached. It is being prepared now — shipment tracking details will be shared here shortly.",
    footer: "Reply here if you have any questions.",
  },
  shipped: {
    header: "Order Shipped",
    body: "Hi {{1}}, good news — your order {{2}} from {{3}} has shipped via {{4}}. Tracking ID: {{5}}. You can follow it on the courier's website using this ID. It should reach you within a few days.",
    footer: "Reply here if you have any questions.",
  },
  delivered: {
    header: "Order Delivered",
    body: "Hi {{1}}, your order {{2}} from {{3}} has been delivered. We hope you love it! If anything is not right, reply here and we will sort it out. Thank you for choosing us.",
    footer: "Reply here if you have any questions.",
  },
};

export function previewText(kind, params) {
  const t = TEMPLATE_TEXT[kind];
  if (!t) return "";
  const body = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => String(params[Number(n) - 1] ?? ""));
  return `${t.header}\n\n${body}\n\n${t.footer}`;
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
  if (!phone) return json({ shipments: [] });

  const owner = await ownerUser(env);
  if (!owner) return json({ shipments: [] });

  const { results } = await env.DB.prepare(
    `SELECT id, number, status, currency, total, courier, tracking_id, shipped_at, delivered_at,
            track_status, track_checked_at, paid_at, created_at
       FROM invoices
      WHERE user_id = ? AND client_phone = ? AND status <> 'VOID'
        AND (status = 'PAID' OR shipped_at IS NOT NULL)
        AND created_at > ?
      ORDER BY created_at DESC LIMIT ?`
  ).bind(owner.id, phone, now() - LOOKBACK_MS, MAX_SHIPMENTS).all();

  const rows = results || [];
  let items = {};
  if (rows.length) {
    const ph = rows.map(() => "?").join(",");
    const li = await env.DB.prepare(
      `SELECT invoice_id, description FROM line_items WHERE invoice_id IN (${ph}) ORDER BY pos`
    ).bind(...rows.map((r) => r.id)).all();
    for (const l of li.results || []) (items[l.invoice_id] ||= []).push(l.description);
  }

  return json({
    shipments: rows.map((r) => ({
      number: r.number,
      status: r.status,
      total: r.total,
      currency: r.currency,
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
    // biz_name is needed for {{3}}; the row does not carry it. Same lookup the
    // rest of the app uses would pull in business.js — the name alone is enough.
    const b = inv.business_id
      ? await env.DB.prepare("SELECT name FROM businesses WHERE id=?").bind(inv.business_id).first().catch(() => null)
      : null;
    const msg = buildDeliveredMessage(env, { to: inv.client_phone, inv: { ...inv, biz_name: b?.name || inv.biz_name } });
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
