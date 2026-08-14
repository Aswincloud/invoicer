// Which business issued this invoice — in one place, on purpose.
//
// Before multiple businesses existed, five separate call sites each reached into
// the user row and copied biz_name, biz_gst, biz_pay and the rest onto the
// invoice being rendered: loadInvoice and emailInvoice in index.js, the shop
// path in ingest.js, and two queries in pay.js. Five copies of a rule was
// survivable while the answer was always "the one business this account has".
//
// It is not survivable now. The answer is per invoice, and getting it wrong is
// silent: the document still renders, still looks right, and carries another
// company's trading name and GSTIN. On a tax document that is the worst class of
// bug — plausible output, wrong facts. So there is exactly one module that knows
// how a business attaches to an invoice, and
//
//     grep -rn 'user\.biz_\|u\.biz_' src/
//
// should stay empty.

import { qrMatrix } from "./qr.js";

// Named to match the columns the renderers already read, so invoice-html.js and
// invoice-pdf.js needed no changes to pick a business up.
export const BIZ_COLUMNS = [
  "biz_name", "biz_email", "biz_addr", "biz_phone", "biz_gst", "biz_pay", "biz_logo",
  "qr_url", "qr_caption",
];

// For queries that already join, e.g. the public share page.
export const BIZ_SELECT = BIZ_COLUMNS.map((c) => `b.${c}`).join(", ");
export const BIZ_JOIN = "LEFT JOIN businesses b ON b.id = i.business_id";

/* The subset of a business row that belongs on a rendered invoice.

   Everything is coerced to a string. A missing business — which 0010 makes
   impossible for existing rows, but a future bug could reintroduce — then
   renders as an invoice with blank business details rather than throwing
   halfway through generating a PDF, or printing the word "undefined" on
   somebody's receipt. */
export function bizFields(b) {
  const out = {};
  for (const c of BIZ_COLUMNS) out[c] = String((b && b[c]) || "");
  return out;
}

export async function businessById(env, userId, id) {
  if (!id) return null;
  return await env.DB.prepare("SELECT * FROM businesses WHERE id=? AND user_id=?")
    .bind(id, userId).first();
}

/* The business a new invoice starts on, and the one the shop path bills under.

   Falls back to the oldest business when no row is flagged default, so a user
   who somehow clears the flag still gets a stable answer instead of a random
   one — a shop order billed under an arbitrary business would be worse than
   billed under the wrong-but-consistent one. */
export async function defaultBusiness(env, userId) {
  return await env.DB.prepare(
    `SELECT * FROM businesses WHERE user_id=?
      ORDER BY is_default DESC, created_at ASC LIMIT 1`
  ).bind(userId).first();
}

/* The business that issued this invoice.

   business_id is the authority. The fallback to the account default exists only
   for a row written before 0010 backfilled — after that migration there are
   none, and a NULL here means something upstream failed to set it. */
export async function businessForInvoice(env, inv) {
  return (await businessById(env, inv.user_id, inv.business_id))
      || (await defaultBusiness(env, inv.user_id));
}

/* Attach the issuing business to an invoice row, ready to render. */
export async function attachBusiness(env, inv) {
  Object.assign(inv, bizFields(await businessForInvoice(env, inv)));
  return inv;
}

/* A business as the browser sees it.

   The QR matrix is computed here rather than in the browser: the client cannot
   import from src/, so shipping the modules is what keeps a single encoder. See
   the header of qr.js. */
export function publicBusiness(b) {
  if (!b) return null;
  const matrix = qrMatrix(b.qr_url);
  return {
    id: b.id,
    isDefault: !!b.is_default,
    biz: {
      bizName: b.biz_name || "", bizEmail: b.biz_email || "", bizAddr: b.biz_addr || "",
      bizPhone: b.biz_phone || "", bizGst: b.biz_gst || "", bizPay: b.biz_pay || "",
      bizLogo: b.biz_logo || "",
      qrUrl: b.qr_url || "", qrCaption: b.qr_caption || "",
    },
    defaults: {
      currency: b.def_currency || "", taxMode: b.def_tax_mode || "",
      taxRate: b.def_tax_rate || "", discount: b.def_discount || "",
      notes: b.def_notes || "", dueDays: b.def_due_days || "",
      prefix: b.def_prefix || "",
    },
    // rows of "0110…", or null when this business has no shop link
    qrRows: matrix ? matrix.map((r) => r.map((d) => (d ? "1" : "0")).join("")) : null,
  };
}

/* Write a business. Used by create and update alike; `b` is the client payload. */
export function businessValues(b) {
  const d = b.defaults || {};
  return [
    String(b.bizName || ""), String(b.bizEmail || ""), String(b.bizAddr || ""),
    String(b.bizPhone || ""), String(b.bizGst || ""), String(b.bizPay || ""),
    String(b.bizLogo || "").slice(0, 200000),
    String(b.qrUrl || "").trim().slice(0, 2000), String(b.qrCaption || "").slice(0, 120),
    String(d.currency || ""), String(d.taxMode || ""), String(d.taxRate || ""),
    String(d.discount || ""), String(d.notes || ""), String(d.dueDays || ""),
    String(d.prefix || ""),
  ];
}

export const BIZ_WRITE_COLUMNS =
  `biz_name,biz_email,biz_addr,biz_phone,biz_gst,biz_pay,biz_logo,
   qr_url,qr_caption,
   def_currency,def_tax_mode,def_tax_rate,def_discount,def_notes,def_due_days,def_prefix`;
