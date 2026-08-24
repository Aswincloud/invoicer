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
  "qr_url", "qr_caption", "biz_sign",
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
      bizSign: b.biz_sign || "",
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

/* ── writing ─────────────────────────────────────────────────────────────────

   A write updates only the keys the payload actually carries.

   This is not a nicety. The Settings modal sends its own subset of fields, and
   when a missing key meant "" every save through it silently blanked whatever
   it did not know about. There is a comment in saveSettings reading "include
   the logo so saving Settings doesn't blank it" — that is this bug, patched
   once per field, and it claimed the shop link and the signature the moment
   they were added. A partial update that nulls the columns it was not told
   about is a trap that keeps collecting victims, so absent means untouched. */

const BIZ_FIELD_MAP = {
  bizName: "biz_name", bizEmail: "biz_email", bizAddr: "biz_addr",
  bizPhone: "biz_phone", bizGst: "biz_gst", bizPay: "biz_pay",
  bizLogo: "biz_logo", qrUrl: "qr_url", qrCaption: "qr_caption",
  bizSign: "biz_sign",
};

const DEFAULTS_MAP = {
  currency: "def_currency", taxMode: "def_tax_mode", taxRate: "def_tax_rate",
  discount: "def_discount", notes: "def_notes", dueDays: "def_due_days",
  prefix: "def_prefix",
};

// Ceilings on the two that carry image data, so one oversized upload cannot
// bloat every row that joins against this table.
const LIMITS = { bizLogo: 200000, bizSign: 200000, qrUrl: 2000, qrCaption: 120 };

const clamp = (key, value) => {
  const s = String(value ?? "");
  const max = LIMITS[key];
  return max ? s.slice(0, max) : s;
};

/* The columns and values a payload actually sets. */
export function businessPatch(b) {
  const cols = [], vals = [];
  for (const [key, col] of Object.entries(BIZ_FIELD_MAP)) {
    if (b[key] === undefined) continue;
    cols.push(col);
    vals.push(key === "qrUrl" ? clamp(key, String(b[key]).trim()) : clamp(key, b[key]));
  }
  const d = b.defaults;
  if (d) {
    for (const [key, col] of Object.entries(DEFAULTS_MAP)) {
      if (d[key] === undefined) continue;
      cols.push(col);
      vals.push(String(d[key] ?? ""));
    }
  }
  return { cols, vals };
}

/* Every column, for an INSERT — where "absent means untouched" has nothing to
   leave untouched and the row needs a value in each. */
export const BIZ_WRITE_COLUMNS =
  [...Object.values(BIZ_FIELD_MAP), ...Object.values(DEFAULTS_MAP)].join(",");

export function businessValues(b) {
  const d = b.defaults || {};
  return [
    ...Object.keys(BIZ_FIELD_MAP).map((k) => clamp(k, b[k])),
    ...Object.keys(DEFAULTS_MAP).map((k) => String(d[k] ?? "")),
  ];
}
