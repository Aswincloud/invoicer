/* Sending an order confirmation over WhatsApp, through Meta's Cloud API.
 *
 * Business-initiated, so it MUST be a template - Meta refuses free-form text to
 * someone who has not messaged in the last 24 hours - and it is billed per
 * delivered message at the utility rate (a few paise in India).
 *
 * ONE template, for PAID invoices only. Aswin takes payment before anything
 * ships, so the message a customer gets is "your order is confirmed, shipping
 * news will follow" - and an unpaid invoice is REFUSED rather than confirmed.
 *
 *   order_confirmed_new   DOCUMENT header (the invoice PDF) + three body params:
 *     Hi {{1}}, thank you for your order! 🎉 Your order {{2}} from {{3}} has
 *     been confirmed successfully. We'll let you know once your order has
 *     been shipped. Thank you for shopping with us! ❤️
 *
 * The header is not optional. This once shipped body-only on the belief the
 * template had no header, and every send failed with Meta's
 * "(#132012) Parameter format does not match format in the created template -
 * header: Format mismatch, expected DOCUMENT, received UNKNOWN". Zero invoice
 * messages had ever been delivered when that was noticed. The components sent
 * MUST mirror the template as approved in Business Manager, component for
 * component - Meta does not fill in a missing one.
 *
 * Created and approved once in Meta Business Manager, not here; the name is
 * configurable because Meta owns it.
 *
 * Feature-flagged by secret presence, the way print and Razorpay are: with no
 * phone-number id or token there is nothing to call, and the button does not
 * appear. The token never touches this repo - `wrangler secret put`.
 */

export const WA_ENV = {
  phoneId:   "WA_PHONE_NUMBER_ID",
  token:     "WA_ACCESS_TOKEN",
  version:   "WA_API_VERSION",       // default below
  tplPaid:   "WA_TEMPLATE_CONFIRMED", // default "order_confirmed_new"
  tplReceipt:"WA_TEMPLATE_RECEIPT",   // default "payment_received" — pay-link payments
  tplRequest:"WA_TEMPLATE_REQUEST",   // default "invoice_pay_online" — unpaid invoices
  lang:      "WA_TEMPLATE_LANG",     // default "en"
};

export const waConfigured = (env) =>
  Boolean(env && env[WA_ENV.phoneId] && env[WA_ENV.token]);

/* A phone number as the Cloud API wants it: country code + national number,
 * digits only, no plus. Fails CLOSED - anything ambiguous is "", and "" sends
 * nothing. A bill going to a stranger because a digit was misread is the one
 * mistake here that cannot be taken back.
 *
 * Indian numbers are the default country: a bare 10-digit mobile (starting
 * 6-9) is taken as +91. Anything already carrying a country code, with or
 * without "+", "00" or spaces, is kept. Landline-shaped and short strings are
 * refused rather than guessed at. */
export function toE164(raw, defaultCc = "91") {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^\s*00/, "+");                 // 00 91 ... -> +91 ...
  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return "";

  if (hadPlus) {
    // Explicit country code. E.164 is 8-15 digits total.
    return s.length >= 8 && s.length <= 15 ? s : "";
  }
  // Bare 10-digit Indian mobile.
  if (s.length === 10 && /^[6-9]/.test(s)) return defaultCc + s;
  // 0-prefixed national dialling: 09xxxxxxxxx.
  if (s.length === 11 && s.startsWith("0") && /^0[6-9]/.test(s)) return defaultCc + s.slice(1);
  // Already has the Indian code without a plus.
  if (s.length === 12 && s.startsWith(defaultCc) && /^..[6-9]/.test(s)) return s;
  return "";
}

/* Shown back to the user: +91 63801 57944. Display only. */
export function prettyE164(e164) {
  const s = String(e164 || "");
  if (/^91\d{10}$/.test(s)) return `+91 ${s.slice(2, 7)} ${s.slice(7)}`;
  return s ? `+${s}` : "";
}

/* Whether this invoice may be sent at all. One place, so the endpoint and any
 * future UI gate agree. Only PAID: the template confirms the order and promises
 * shipping news, and both would be false on an unpaid bill. */
export function canSendWhatsApp(inv) {
  const st = String(inv && inv.status || "").toUpperCase();
  if (st === "PAID") return { ok: true };
  if (st === "VOID") return { ok: false, why: "This invoice is cancelled." };
  return { ok: false,
           why: "Only paid invoices are sent on WhatsApp for now - the message thanks " +
                "the customer for paying. Mark it PAID first." };
}

/* The template's body params, in ITS order: {{1}} customer, {{2}} order number,
 * {{3}} business. Shared by the send and the preview so they cannot disagree.
 * Blanks fall back rather than sending "Hi ," - Meta rejects empty params. */
export function confirmedParams(inv) {
  return [
    String(inv.client_name || "").trim() || "there",
    String(inv.number || ""),
    String(inv.biz_name || "").trim() || "us",
  ];
}

/* Which template a PAID invoice gets. Shop orders are orders: "confirmed,
 * shipping news will follow" is true of them. A /pay payment is often not an
 * order at all — consulting, a website, a repair — so it gets a plain receipt:
 *
 *   payment_received   DOCUMENT header (the receipt PDF) + five body params:
 *     Hi {{1}}, we've received your payment of {{2}} for {{3}}. Your receipt
 *     {{4}} is attached. Thank you for choosing {{5}} — we appreciate your
 *     business.                                   (created 2026-09-26, UTILITY)
 *
 * Decided by where the invoice came from, so the webhook, the shop ingest and
 * the dashboard button cannot disagree about which message a row gets. */
export function templateKindFor(inv) {
  return String(inv && inv.source || "") === "paylink" ? "receipt" : "confirmed";
}

/* "₹250", or "₹1,234.50" when there are paise. From the invoice's own amount —
 * rzp_amount (paise, what Razorpay captured) first, the stored total second —
 * never from a payment lookup that may have failed. */
export function rupeesText(inv) {
  const paise = Number(inv && inv.rzp_amount) || Math.round(Number(inv && inv.total || 0) * 100);
  const r = paise / 100;
  const cur = (inv && inv.currency) || "₹";
  return cur + (Number.isInteger(r)
    ? r.toLocaleString("en-IN")
    : r.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

/* payment_received's body params, in ITS order: {{1}} customer, {{2}} amount,
 * {{3}} what it was for, {{4}} receipt number, {{5}} business. */
export function receiptParams(inv, what) {
  return [
    String(inv.client_name || "").trim() || "there",
    rupeesText(inv),
    String(what || "").trim() || "your order",
    String(inv.number || ""),
    String(inv.biz_name || "").trim() || "us",
  ];
}

export function buildReceiptMessage(env, { to, inv, pdfUrl, what }) {
  const name = env[WA_ENV.tplReceipt] || "payment_received";
  const safeNum = String(inv.number || "receipt").replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name, language: { code: env[WA_ENV.lang] || "en" }, components: [
      { type: "header",
        parameters: [{ type: "document", document: { link: pdfUrl, filename: `${safeNum}.pdf` } }] },
      { type: "body", parameters: receiptParams(inv, what).map((text) => ({ type: "text", text })) },
    ] },
  };
}

/* The one entry point for "this PAID invoice's WhatsApp": picks the template by
 * templateKindFor(). `what` is the first line item's description, for receipts. */
export function buildPaidMessage(env, args) {
  return templateKindFor(args.inv) === "receipt"
    ? buildReceiptMessage(env, args)
    : buildTemplateMessage(env, args);
}

/* Whether an UNPAID invoice may be sent as a payment request. The request
 * carries two buttons, Pay online (/i/<token>) and Pay by UPI (/u/<token>), so
 * it is only offered for what those pages can actually take: an INR invoice of
 * at least ₹1 that is neither paid nor cancelled.
 *
 *   invoice_pay_online   DOCUMENT header (the invoice PDF) + four params:
 *     Hi {{1}}, your invoice {{2}} for {{3}} from {{4}} is ready. The invoice is
 *     attached. You can pay securely online by card, UPI or net banking using
 *     the button below.
 *     [Pay online] https://invoicer.aswincloud.com/i/{{1}}
 *                                                 (created 2026-09-29, UTILITY)
 *
 * One button, Razorpay only, so every payment it leads to is confirmed by the
 * webhook. It replaced invoice_payment_request, whose second button paid the
 * owner's personal UPI ID — a payment nothing here can see, so the customer
 * could never be told it succeeded. /u/<token> still works for links already
 * sent with that button. */
export function canRequestPayment(inv, totalPaise) {
  const st = String(inv && inv.status || "").toUpperCase();
  if (st === "PAID") return { ok: false, why: "This invoice is already paid." };
  if (st === "VOID") return { ok: false, why: "This invoice is cancelled." };
  if ((inv && inv.currency || "₹") !== "₹") return { ok: false, why: "Payment requests are for ₹ invoices only." };
  if (!(totalPaise >= 100)) return { ok: false, why: "The invoice total is below ₹1." };
  return { ok: true };
}

/* {{1}} customer, {{2}} invoice number, {{3}} amount, {{4}} business. */
export function requestParams(inv, totalPaise) {
  return [
    String(inv.client_name || "").trim() || "there",
    String(inv.number || ""),
    rupeesText({ rzp_amount: totalPaise, currency: inv.currency }),
    String(inv.biz_name || "").trim() || "us",
  ];
}

export function buildPaymentRequestMessage(env, { to, inv, pdfUrl, token, totalPaise }) {
  const name = env[WA_ENV.tplRequest] || "invoice_pay_online";
  const safeNum = String(inv.number || "invoice").replace(/[^A-Za-z0-9._-]/g, "-");
  // A URL button whose fixed prefix lives on the template; only the share token
  // is sent. It is the template's only button, index "0".
  const button = (index) => ({ type: "button", sub_type: "url", index: String(index),
                               parameters: [{ type: "text", text: String(token) }] });
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name, language: { code: env[WA_ENV.lang] || "en" }, components: [
      { type: "header", parameters: [{ type: "document", document: { link: pdfUrl, filename: `${safeNum}.pdf` } }] },
      { type: "body", parameters: requestParams(inv, totalPaise).map((text) => ({ type: "text", text })) },
      button(0),
    ] },
  };
}

/* The request body for one invoice. Pure, so it can be tested without a network.
 *
 *   to        E.164 digits
 *   inv       the invoice row with business attached */
export function buildTemplateMessage(env, { to, inv, pdfUrl }) {
  const name = env[WA_ENV.tplPaid] || "order_confirmed_new";
  const safeNum = String(inv.number || "invoice").replace(/[^A-Za-z0-9._-]/g, "-");
  const components = [
    // The template's DOCUMENT header. Meta fetches the file from this URL and
    // shows it as a card named `filename`, so the card reads as the invoice.
    { type: "header",
      parameters: [{ type: "document",
                     document: { link: pdfUrl, filename: `${safeNum}.pdf` } }] },
    { type: "body",
      parameters: confirmedParams(inv).map((text) => ({ type: "text", text })) },
  ];
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name, language: { code: env[WA_ENV.lang] || "en" }, components },
  };
}

/* POST it. Returns { ok, id } or { ok:false, error, status }. Never throws on
 * an HTTP error - the caller turns it into a 502 with Meta's own message, which
 * is the useful one ("template not found", "recipient not opted in").
 *
 * Every message a customer is sent is then sent, identically, to WA_COPY_TO
 * when that is set (a Worker secret: the owner's own WhatsApp number), so the
 * owner sees on a real phone exactly what went out — Meta keeps no sent log,
 * and API-sent messages do not appear in Chatwoot. Only after Meta accepted
 * the customer's copy, never for a message already addressed to that number,
 * and a failed copy is logged and ignored: it must not turn a delivered
 * customer message into an error. Each copy is a paid utility message outside
 * a 24 h window (about 14 paise with GST, Sep 2026). */
export async function sendTemplate(env, body) {
  const res = await postMessage(env, body);
  const copyTo = toE164(env.WA_COPY_TO);
  if (res.ok && copyTo && copyTo !== toE164(body?.to)) {
    const copy = await postMessage(env, { ...body, to: copyTo });
    if (!copy.ok) console.error("whatsapp owner copy failed", copy.error);
  }
  return res;
}

async function postMessage(env, body) {
  const ver = env[WA_ENV.version] || "v23.0";
  const url = `https://graph.facebook.com/${ver}/${env[WA_ENV.phoneId]}/messages`;
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env[WA_ENV.token]}`,
                 "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "network: " + (e?.message || e), status: 0 };
  }
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) {
    const m = data?.error?.message || `HTTP ${r.status}`;
    const d = data?.error?.error_data?.details;
    return { ok: false, error: d ? `${m} — ${d}` : m, status: r.status,
             code: data?.error?.code };
  }
  return { ok: true, id: data?.messages?.[0]?.id || "" };
}
