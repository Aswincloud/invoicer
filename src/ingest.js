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

import { json, bad, uid, now, sendEmail, hmacHex, timingSafeEqualHex } from "./lib.js";
import { renderInvoiceEmail, computeTotals, logoAttachment, qrAttachment,
         signAttachment, payQrAttachment } from "./invoice-html.js";
import { renderInvoicePdf, toBase64 } from "./invoice-pdf.js";
import { bizFields, defaultBusiness } from "./business.js";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Paise on the wire, rupees in the invoice. The shop stores every amount as an
// INTEGER number of paise precisely so nothing is ever a float; Invoicer's
// columns are REAL rupees. This is the one conversion, in one place.
const rupees = (paise) => Number(paise || 0) / 100;

// ── the handler ──────────────────────────────────────────────────────────────
export async function ingestOrder(request, env) {
  // Kill switch first, so a disabled endpoint does no work and writes nothing.
  if (String(env.SHOP_INGEST_ENABLED ?? "").toLowerCase() !== "true") {
    return json({ error: "shop ingest is disabled" }, 503);
  }

  if (!env.SHOP_INGEST_SECRET) {
    // Fails CLOSED. Without a secret there is no way to tell the shop from
    // anyone else, and the consequence of guessing wrong is sending invoices
    // from Aswin's business to strangers.
    console.error("SHOP_INGEST_SECRET is not set — refusing");
    return json({ error: "shop ingest is disabled" }, 503);
  }

  // Raw body, before any parsing: the signature covers the exact bytes sent, and
  // re-serialising a parsed object produces different ones.
  const raw = await request.text();
  const signature = request.headers.get("x-shop-signature") || "";
  if (!signature) return bad("unauthorized", 401);

  const expected = await hmacHex(raw, env.SHOP_INGEST_SECRET);
  if (!timingSafeEqualHex(expected, signature)) return bad("unauthorized", 401);

  let b;
  try {
    b = JSON.parse(raw || "{}");
  } catch {
    return bad("bad request", 400);
  }

  // The signature proves the body came from something holding the secret; the
  // timestamp proves it was sent recently. Without this, one captured request
  // re-sends that invoice forever.
  const skew = Math.abs(now() - Number(b?.ts || 0));
  if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_MS) return bad("unauthorized", 401);

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
         client_addr,client_gst,total,source,source_ref,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, user.id, biz ? biz.id : null,
      inv.number, inv.issue_date, inv.due_date, inv.currency, inv.tax_mode,
      inv.tax_rate, inv.discount_pct, inv.shipping, inv.shipping_mode, inv.round_off,
      inv.status, inv.notes, inv.client_name, inv.client_email, inv.client_addr,
      inv.client_gst, total, "shop", receipt, t, t,
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
    return json({ ok: true, id, number: inv.number, total, emailed: false,
                  error: "invoice created but email failed" });
  }

  return json({ ok: true, id, number: inv.number, total, emailed: true });
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
