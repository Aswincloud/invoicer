// Invoices raised automatically from a paid order at 3d-prints.aswincloud.com.
//
// ── The invariant ────────────────────────────────────────────────────────────
//
//   Amounts are TRANSCRIBED, never recomputed.
//
// The customer has already been charged. Every number on this invoice was
// decided by priceCart() in the shop and confirmed by Razorpay, so the invoice's
// job is to state what happened — not to work out what should have happened.
// Invoicer must not apply tax, rounding, its own shipping rules, or a discount
// percentage of its own.
//
// An invoice whose total disagrees with the customer's bank statement is worse
// than no invoice at all: it turns a routine document into a support argument and
// makes both numbers untrustworthy. So the last thing this module does before
// writing is assert that the rendered total equals the paid total exactly, and
// refuse if it does not.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// Service-to-service, called only by the shop Worker. It is NOT session
// authenticated — it sits above the cookie gate in index.js — so it carries its
// own: HMAC-SHA256 over the raw body, plus a timestamp replay window. Without
// that it is an open "email anyone an invoice from Aswin's business" endpoint.

import { json, bad, uid, now, sendEmail, hmacHex, timingSafeEqualHex, randToken } from "./lib.js";
import { waConfigured, toE164, buildTemplateMessage, sendTemplate } from "./wa.js";
import { shopCourier, normalizeAwb, buildShippedMessage, buildDeliveredMessage } from "./shipment.js";
import { renderInvoiceEmail, computeTotals, logoAttachment, qrAttachment,
         signAttachment, payQrAttachment } from "./invoice-html.js";
import { renderInvoicePdf, toBase64 } from "./invoice-pdf.js";
import { bizFields, defaultBusiness, attachBusiness } from "./business.js";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Paise on the wire, rupees in the invoice. The shop stores every amount as an
// INTEGER number of paise precisely so nothing is ever a float; Invoicer's
// columns are REAL rupees. This is the one conversion, in one place.
const rupees = (paise) => Number(paise || 0) / 100;

// ── who may call these ───────────────────────────────────────────────────────
//
// One verifier for every shop-facing endpoint, so a second endpoint cannot be
// added with a weaker check by accident. Returns { body } on success, or
// { response } to be returned as-is.
//
//   kill switch → secret present → raw bytes → HMAC over raw → parse → replay
//
// The signature is checked over the RAW body, before any parsing: re-serialising
// a parsed object produces different bytes, so a signature over those would never
// match. The timestamp then proves the request was sent recently — without it,
// one captured request replays forever.
export async function verifyShopRequest(request, env) {
  // Kill switch first, so a disabled endpoint does no work and writes nothing.
  if (String(env.SHOP_INGEST_ENABLED ?? "").toLowerCase() !== "true") {
    return { response: json({ error: "shop ingest is disabled" }, 503) };
  }

  if (!env.SHOP_INGEST_SECRET) {
    // Fails CLOSED. Without a secret there is no way to tell the shop from
    // anyone else, and the consequence of guessing wrong is sending invoices —
    // and now WhatsApp messages — from Aswin's business to strangers.
    console.error("SHOP_INGEST_SECRET is not set — refusing");
    return { response: json({ error: "shop ingest is disabled" }, 503) };
  }

  const raw = await request.text();
  const signature = request.headers.get("x-shop-signature") || "";
  if (!signature) return { response: bad("unauthorized", 401) };

  const expected = await hmacHex(raw, env.SHOP_INGEST_SECRET);
  if (!timingSafeEqualHex(expected, signature)) return { response: bad("unauthorized", 401) };

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return { response: bad("bad request", 400) };
  }

  const skew = Math.abs(now() - Number(body?.ts || 0));
  if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_MS) return { response: bad("unauthorized", 401) };

  return { body };
}

// ── the handler ──────────────────────────────────────────────────────────────
export async function ingestOrder(request, env) {
  const v = await verifyShopRequest(request, env);
  if (v.response) return v.response;
  const b = v.body;

  const receipt = String(b?.receipt || "").trim().slice(0, 60);
  if (!receipt) return bad("receipt required", 400);

  // ── who is issuing it ──
  //
  // The invoice header (business name, GSTIN, pay-to details) comes from one of
  // the account's businesses, so an invoice cannot be raised without one.
  // Resolved from CONFIG, never from the request — otherwise the caller could
  // pick whose business name appears on an invoice.
  //
  // A shop order is always billed under the account's DEFAULT business. The
  // request has no say: letting it choose would hand a caller the ability to
  // issue invoices under any of Aswin's trading names, GSTIN included.
  const ownerEmail = String(env.INVOICE_OWNER_EMAIL || "").trim().toLowerCase();
  if (!ownerEmail) {
    console.error("INVOICE_OWNER_EMAIL is not set — cannot attribute the invoice");
    return json({ error: "invoicing is not configured" }, 503);
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE lower(email)=?")
    .bind(ownerEmail).first();
  if (!user) {
    // Deliberately NOT creating one. A user row conjured here would have no
    // business name, so the invoice would go out headed "Your Business".
    console.error("no Invoicer account for", ownerEmail);
    return json({ error: "invoicing is not configured" }, 503);
  }

  // ── idempotency ──
  //
  // Checked before doing any work, and backed by the UNIQUE index on source_ref
  // for the case where two deliveries race past this check simultaneously.
  const existing = await env.DB.prepare(
    "SELECT id, number, total FROM invoices WHERE source_ref=?"
  ).bind(receipt).first();
  if (existing) {
    return json({ ok: true, duplicate: true, id: existing.id, number: existing.number });
  }

  const biz = await defaultBusiness(env, user.id);
  if (!biz) {
    // 0010 gives every account one, so this means the account was created after
    // the migration without a business being made for it. Refusing beats
    // sending an invoice headed "Your Business" with no GSTIN on it.
    console.error("no business configured for", ownerEmail);
    return json({ error: "invoicing is not configured" }, 503);
  }

  const built = buildInvoice(b, receipt, user);
  if (built.error) return bad(built.error, 400);
  const { inv, items, total } = built;

  const id = uid();
  const t = now();

  try {
    await env.DB.prepare(
      `INSERT INTO invoices (id,user_id,business_id,number,issue_date,due_date,currency,tax_mode,tax_rate,
         discount_pct,shipping,shipping_mode,round_off,status,notes,client_name,client_email,
         client_addr,client_gst,client_phone,total,source,source_ref,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, user.id, biz ? biz.id : null,
      inv.number, inv.issue_date, inv.due_date, inv.currency, inv.tax_mode,
      inv.tax_rate, inv.discount_pct, inv.shipping, inv.shipping_mode, inv.round_off,
      inv.status, inv.notes, inv.client_name, inv.client_email, inv.client_addr,
      inv.client_gst, inv.client_phone, total, "shop", receipt, t, t,
    ).run();
  } catch (e) {
    // The UNIQUE index fired: a concurrent delivery won the race. That is the
    // index doing its job, not an error — return the invoice that won.
    if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
      const won = await env.DB.prepare(
        "SELECT id, number FROM invoices WHERE source_ref=?"
      ).bind(receipt).first();
      if (won) return json({ ok: true, duplicate: true, id: won.id, number: won.number });
    }
    throw e;
  }

  const stmt = env.DB.prepare(
    "INSERT INTO line_items (id,invoice_id,pos,description,qty,rate) VALUES (?,?,?,?,?,?)"
  );
  const batch = items.map((it, i) => stmt.bind(uid(), id, i, it.description, it.qty, it.rate));
  if (batch.length) await env.DB.batch(batch);

  // ── send it ──
  //
  // Same render and same transport as the dashboard's "email invoice" button, so
  // there is one invoice template and one delivery path, not two that drift.
  const rendered = { ...inv, total, ...bizFields(biz) };
  const bizName = String(rendered.biz_name || "").trim();

  // The logo travels as a CID attachment, not as the stored data: URI — mail
  // clients strip those, which is why the first invoices arrived with a broken
  // image where the logo should be. logoAttachment() returns null when there is
  // no logo or it is not a usable image, and the template then falls back to the
  // initial badge rather than rendering a broken <img>.
  const logo = logoAttachment(rendered.biz_logo);
  const qr = qrAttachment(rendered);
  const sign = signAttachment(rendered);
  const payQr = payQrAttachment(rendered);

  const attachments = [];
  if (logo) attachments.push(logo.attachment);
  if (qr) attachments.push(qr.attachment);
  if (sign) attachments.push(sign.attachment);
  if (payQr) attachments.push(payQr.attachment);

  // A PDF copy, generated here rather than in a browser — there is no browser on
  // this path. Wrapped, because a layout bug in the generator must not cost the
  // customer their invoice: the email body IS the invoice, and arriving without
  // the attachment is a far better failure than not arriving at all.
  try {
    const pdf = renderInvoicePdf(rendered, items, computeTotals(rendered, items), { showGift: true });
    const safeNum = String(inv.number || "invoice").replace(/[^A-Za-z0-9._-]/g, "-");
    attachments.push({
      filename: `${safeNum}.pdf`,
      content: toBase64(pdf),
      content_type: "application/pdf",
    });
  } catch (e) {
    console.error("invoice pdf failed", receipt, e?.message || e);
  }

  const sent = await sendEmail(env, {
    to: inv.client_email,
    fromName: `${bizName || "Invoicer"} Billing`,
    subject: `Invoice ${inv.number} — order ${receipt}`,
    // No payUrl: a shop order is already paid, so the fourth argument stays null
    // and the QR goes in the fifth.
    html: renderInvoiceEmail(rendered, items, {
      logoSrc: logo ? logo.src : "",
      qrSrc: qr ? qr.src : "",
      signSrc: sign ? sign.src : "",
      paySrc: payQr ? payQr.src : "",
      showGift: true,
    }),
    text: `Invoice ${inv.number} for order ${receipt}. Total ${inv.currency} ${total.toFixed(2)}. A PDF copy is attached.`,
    attachments: attachments.length ? attachments : undefined,
  });

  if (!sent.ok) {
    // The invoice row is KEPT. It is a real document for a real payment, and
    // deleting it because an email bounced would lose the record of a sale — the
    // dashboard's re-send button exists for exactly this.
    console.error("invoice email failed", receipt, sent.status, sent.error);
    // `total` is included on this path too. The caller logs what it gets back,
    // and a response that omits the amount on the failure path is exactly where
    // you want it most — it is the line that tells you what the unsent invoice
    // was for.
    const whatsapp = await sendShopConfirmation(env, { id, inv, rendered, receipt });
    return json({ ok: true, id, number: inv.number, total, emailed: false, whatsapp,
                  error: "invoice created but email failed" });
  }

  const whatsapp = await sendShopConfirmation(env, { id, inv, rendered, receipt });
  return json({ ok: true, id, number: inv.number, total, emailed: true, whatsapp });
}

// ── the WhatsApp confirmation ────────────────────────────────────────────────
//
// order_confirmed_new, with the invoice PDF as its DOCUMENT header — the same
// message the dashboard's "Send invoice" button sends, now sent automatically the
// moment a shop order is invoiced. Same builder, same token scheme, so the two
// paths cannot drift.
//
// Never fails the ingest: the invoice exists and the email was attempted whether
// or not Meta accepts the message. Returns a word the shop can log.
//
//   "sent"     accepted by Meta; wa_message_id recorded
//   "skipped"  WhatsApp not configured here, or no usable mobile on the order
//   "failed"   Meta refused; logged with Meta's own reason
//
// Idempotent under Razorpay redelivery for free: both duplicate branches above
// return before this runs, so a redelivered webhook cannot send a second one.
async function sendShopConfirmation(env, { id, inv, rendered, receipt }) {
  return sendPaidConfirmation(env, { id, inv: { ...rendered, client_phone: inv.client_phone }, label: receipt });
}

// One PAID invoice's WhatsApp confirmation, for every path that settles an
// invoice without a human pressing the dashboard button: the shop's ingest above
// and the pay-link webhook (notifyPaid in src/pay.js). Until 2026-09-26 the
// pay-link path had no WhatsApp step at all, despite its header saying it did.
//
// `inv` carries client_phone (E.164 or ""), client_name, number and biz_name —
// the joined row both callers already hold. Returns "sent" | "failed" |
// "skipped" | "already_sent"; never throws, never fails the caller.
export async function sendPaidConfirmation(env, { id, inv, label }) {
  if (!waConfigured(env)) return "skipped";
  const to = inv.client_phone;                 // already E.164 or "" (buildInvoice / invoiceFromPaidOrder)
  if (!to) return "skipped";
  if (inv.wa_message_id) return "already_sent";

  // Meta fetches the PDF from /i/<token>.pdf — the pay page's share token. Minted
  // here on first use and kept, exactly as whatsappInvoice() does in index.js.
  const token = randToken(16);
  await env.DB.prepare(
    "UPDATE invoices SET share_token=COALESCE(share_token, ?), updated_at=? WHERE id=?"
  ).bind(token, now(), id).run();
  const row = await env.DB.prepare("SELECT share_token FROM invoices WHERE id=?").bind(id).first();
  const pdfUrl = `${String(env.APP_BASE_URL || "").replace(/\/+$/, "")}/i/${row?.share_token || token}.pdf`;

  const res = await sendTemplate(env, buildTemplateMessage(env, { to, inv, pdfUrl }));
  if (!res.ok) {
    console.error("whatsapp confirmation failed", label, res.status, res.error);
    return "failed";
  }
  await env.DB.prepare(
    "UPDATE invoices SET wa_message_id=?, wa_sent_at=?, updated_at=? WHERE id=?"
  ).bind(res.id, now(), now(), id).run();
  return "sent";
}

// ── shipped / delivered, from the shop dashboard ────────────────────────────
//
// POST /api/ingest/shipment  { ts, receipt, kind: "shipped"|"delivered", courier?, tracking? }
//
// The shop marks an order shipped or delivered and tells us; we record it on the
// invoice and send the matching template, exactly as the dashboard's WhatsApp
// menu does for a hand-raised invoice (whatsappSend in index.js). Same verifier
// as ingest, same owner scoping, same recording — a second signed endpoint with
// its own rules is how the two would drift.
//
// Sends at most ONCE per kind per invoice: if wa_shipped_message_id (or the
// delivered one) is already set, this answers "already_sent" and sends nothing.
// The shop only calls on a status TRANSITION, so this is belt and braces — but a
// dashboard "correct the tracking number" re-save must never re-notify a customer.
export async function ingestShipment(request, env) {
  const v = await verifyShopRequest(request, env);
  if (v.response) return v.response;
  const b = v.body;

  const receipt = String(b?.receipt || "").trim().slice(0, 60);
  if (!receipt) return bad("receipt required", 400);
  const kind = String(b?.kind || "");
  if (kind !== "shipped" && kind !== "delivered") return bad("kind must be shipped or delivered", 400);

  const ownerEmail = String(env.INVOICE_OWNER_EMAIL || "").trim().toLowerCase();
  if (!ownerEmail) return json({ error: "invoicing is not configured" }, 503);
  const user = await env.DB.prepare("SELECT * FROM users WHERE lower(email)=?").bind(ownerEmail).first();
  if (!user) return json({ error: "invoicing is not configured" }, 503);

  // Scoped three ways: the receipt, the shop as source, the owner as user. A
  // receipt alone would let a guessed AP- number reach a hand-raised invoice.
  const inv = await env.DB.prepare(
    "SELECT * FROM invoices WHERE source_ref=? AND source='shop' AND user_id=?"
  ).bind(receipt, user.id).first();
  if (!inv) return bad("no invoice for that order", 404);
  // The templates say "your order from {{3}}", and {{3}} is the business that
  // issued the invoice — which lives on the businesses row, not the invoice. The
  // dashboard's path gets this from loadInvoice(); this one has to do it itself,
  // or the customer reads "your order from us". The test that caught that stays.
  await attachBusiness(env, inv);

  if (!waConfigured(env)) return json({ ok: true, whatsapp: "skipped", why: "whatsapp not configured" });
  const to = toE164(inv.client_phone);
  if (!to) return json({ ok: true, whatsapp: "skipped", why: "no valid mobile on the order" });

  if (kind === "shipped") {
    if (inv.wa_shipped_message_id) return json({ ok: true, whatsapp: "already_sent" });
    const courier = shopCourier(b?.courier);
    const awb = normalizeAwb(b?.tracking);
    // {{5}} is the tracking id and Meta rejects an empty parameter, so without an
    // awb there is no message to send. The email still went from the shop.
    if (!awb) return json({ ok: true, whatsapp: "skipped", why: "no tracking number" });

    // Record first: the shipment is a fact about the order whether or not Meta
    // accepts the message. shipped_at is set once and kept.
    await env.DB.prepare(
      `UPDATE invoices SET courier=?, tracking_id=?, shipped_at=COALESCE(shipped_at, ?), updated_at=? WHERE id=?`
    ).bind(courier.id || courier.name, awb, now(), now(), inv.id).run();

    const res = await sendTemplate(env, buildShippedMessage(env, { to, inv, courier: courier.id, courierName: courier.name, awb }));
    if (!res.ok) {
      console.error("shop whatsapp shipped failed", receipt, res.status, res.error);
      return json({ ok: true, whatsapp: "failed", why: res.error });
    }
    await env.DB.prepare(
      "UPDATE invoices SET wa_shipped_message_id=?, wa_shipped_at=?, updated_at=? WHERE id=?"
    ).bind(res.id, now(), now(), inv.id).run();
    return json({ ok: true, whatsapp: "sent", id: res.id, tracked: Boolean(courier.id) });
  }

  // delivered
  if (inv.wa_delivered_message_id) return json({ ok: true, whatsapp: "already_sent" });
  await env.DB.prepare(
    "UPDATE invoices SET delivered_at=COALESCE(delivered_at, ?), track_status='delivered', updated_at=? WHERE id=?"
  ).bind(now(), now(), inv.id).run();
  const res = await sendTemplate(env, buildDeliveredMessage(env, { to, inv }));
  if (!res.ok) {
    console.error("shop whatsapp delivered failed", receipt, res.status, res.error);
    return json({ ok: true, whatsapp: "failed", why: res.error });
  }
  await env.DB.prepare(
    "UPDATE invoices SET wa_delivered_message_id=?, wa_delivered_at=?, updated_at=? WHERE id=?"
  ).bind(res.id, now(), now(), inv.id).run();
  return json({ ok: true, whatsapp: "sent", id: res.id });
}

// ── mapping a shop order onto an invoice ─────────────────────────────────────
//
// Exported for testing: this is where the money is, and it is worth asserting
// against directly rather than only through the HTTP layer.
export function buildInvoice(b, receipt, user) {
  const rawItems = Array.isArray(b?.items) ? b.items : [];
  if (!rawItems.length) return { error: "order has no items" };

  const email = String(b?.customer?.email || "").trim();
  if (!email) return { error: "customer email required" };

  const items = rawItems.map((it) => ({
    description: String(it?.name || "Item").slice(0, 300),
    qty: Number(it?.qty || 0),
    rate: rupees(it?.price_paise),
  }));

  // Discount as a NEGATIVE LINE ITEM, not as a percentage.
  //
  // Invoicer models discount as a percentage of subtotal; the shop computes an
  // absolute paise amount (a ₹300 cap, a fixed-amount code, a ceil-to-rupee
  // percentage). Back-computing a percentage from the amount would rarely divide
  // cleanly — ₹300 off ₹1,299 is 23.0946...% — and the rounding would put the
  // invoice a rupee or two away from what was actually charged.
  //
  // A line item keeps the arithmetic exact and, as a bonus, names the code the
  // customer used instead of hiding it in a percentage.
  const discountPaise = Number(b?.discount_paise || 0);
  if (discountPaise > 0) {
    const code = String(b?.coupon_code || "").trim();
    items.push({
      description: code ? `Discount (promo code ${code})` : "Discount",
      qty: 1,
      rate: -rupees(discountPaise),
    });
  }

  const addr = [b?.customer?.addr_line, b?.customer?.addr_city,
                b?.customer?.addr_state, b?.customer?.addr_pin]
    .map((x) => String(x || "").trim()).filter(Boolean).join(", ");

  // Invoice number derives from the receipt, which is already unique per order
  // and already printed on the customer's confirmation email — so an invoice can
  // be matched to an order at a glance, and two orders can never collide.
  //
  // The form's own numbering is PREFIX-YEAR-<4 random digits> (public/app.js),
  // which is fine for a human filling in one invoice and wrong for automated
  // issuance: random numbers collide, and a document about money should not be
  // able to.
  const bare = receipt.replace(/^AP-/, "");
  const year = new Date(Number(b?.paid_at) || now()).getFullYear();
  const number = `AP-${year}-${bare}`.toUpperCase();

  const issueDate = new Date(Number(b?.paid_at) || now()).toISOString().slice(0, 10);

  const inv = {
    number,
    issue_date: issueDate,
    // No due date: it is already paid. A due date on a settled invoice reads as
    // a demand for money the customer has handed over.
    due_date: "",
    currency: "₹",
    // The three that enforce the invariant. The shop charged no tax, applied its
    // discount already, and rounded already — so all three must be inert here or
    // the invoice total would drift from the amount charged.
    tax_mode: "none",
    tax_rate: 0,
    discount_pct: 0,
    round_off: 0,
    shipping: rupees(b?.shipping_paise),
    shipping_mode: "",
    status: "PAID",
    notes: `Paid online on ${issueDate}. Order reference ${receipt}.`,
    client_name: String(b?.customer?.name || "").slice(0, 200),
    client_email: email,
    client_addr: addr,
    client_gst: "",
    // The mobile the customer typed at checkout, as E.164 digits or "". toE164
    // fails CLOSED: anything it cannot be sure is one mobile number becomes ""
    // and nothing is sent to it. A confirmation reaching a stranger because a
    // digit was misread is the one mistake here that cannot be taken back.
    client_phone: toE164(b?.customer?.phone),
  };

  const t = computeTotals(inv, items);

  // THE CHECK. Everything above is arithmetic that should agree with the shop;
  // this is where that is verified rather than assumed.
  //
  // Compared in paise as integers: computeTotals works in rupee floats, and
  // 0.1 + 0.2 !== 0.3 is exactly the class of bug that would otherwise put an
  // invoice one paisa off and make it look wrong.
  const paidPaise = Number(b?.total_paise || 0);
  const renderedPaise = Math.round(t.total * 100);
  if (renderedPaise !== paidPaise) {
    console.error("invoice total does not match the amount paid",
                  { receipt, renderedPaise, paidPaise });
    return { error: "invoice total does not match the amount paid" };
  }

  return { inv, items, total: t.total };
}
