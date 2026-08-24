// Server-side invoice HTML (for the "email invoice to client" feature).
// Kept email-safe: inline styles, table layout, no <style>/@page.

import { qrMatrix, qrPngBase64 } from "./qr.js";
import { signPngBase64 } from "./signature.js";

// Exported so the public pay page escapes with the same function this template
// does, rather than carrying a second copy that can drift from it.
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function money(cur, n) {
  return (cur ? cur + " " : "") + plain(cur, n);
}

// The same figure without the currency symbol — for the Rate column, which sits
// directly beside Amount. Rate used to be a bare toFixed(2), so "1200.00" was
// printed next to "₹ 1,200.00": two numeric columns, two groupings, one of them
// looking unfinished.
export function plain(cur, n) {
  const loc = cur === "₹" ? "en-IN" : "en-US";
  return Number(n || 0).toLocaleString(loc,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function computeTotals(inv, items) {
  const subtotal = items.reduce((s, i) => s + (i.qty || 0) * (i.rate || 0), 0);
  const disc = subtotal * (inv.discount_pct || 0) / 100;
  // Shipping is part of the taxable value (standard GST treatment for freight
  // on a composite supply), so it lands before tax — not after.
  const shipping = +inv.shipping || 0;
  const taxable = subtotal - disc + shipping;
  const rate = inv.tax_rate || 0;
  let taxRows = [], taxTotal = 0;
  if (inv.tax_mode === "gst") {
    const half = taxable * (rate / 2) / 100;
    taxRows = [[`CGST (${rate / 2}%)`, half], [`SGST (${rate / 2}%)`, half]];
    taxTotal = half * 2;
  } else if (inv.tax_mode === "single") {
    const t = taxable * rate / 100;
    taxRows = [[`Tax (${rate}%)`, t]]; taxTotal = t;
  }
  // Round the grand total to a whole unit when the invoice was saved with it on,
  // shown as its own line. Subtotal, discount, shipping and each tax row stay
  // exact — mirrors computeTotals() in public/app.js.
  const gross = taxable + taxTotal;
  const total = inv.round_off ? Math.round(gross) : gross;
  return { subtotal, disc, shipping, taxable, taxRows, gross, round: total - gross, total };
}

// Only worth a row when it actually moves the total; below half a paisa it
// would print as "0.00" and read as a bug.
export const showRoundOff = (t) => Math.abs(t.round) >= 0.005;

/* How many things are in the box.

   UNITS, not lines — the sum of the quantities, which is what a till receipt
   means by "items" and what a customer can count against what they were handed.
   Eight lines and twenty-one units are both true of the same invoice, and only
   one of them can be checked without reading.

   Negative-amount lines are excluded: ingest.js models a promo discount as a
   line item with qty 1 and a negative rate, so counting it as goods would
   overstate every discounted order by one.

   Mirrored by itemUnits() in public/app.js for the preview and the receipt. */
export function itemUnits(items) {
  return (items || []).reduce((n, i) => {
    const qty = Number(i.qty) || 0;
    return qty * (Number(i.rate) || 0) < 0 ? n : n + qty;
  }, 0);
}

// Whole numbers print bare; a fractional quantity (billed hours, metres of
// filament) keeps its decimals rather than being rounded into a lie.
export const fmtUnits = (n) =>
  Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));

/* What belongs where "PAY TO" sits.

   A settled invoice must not carry payment instructions. Handing someone a
   receipt that still says "UPI aswincloud@hdfcbank" invites a second payment
   for something already paid for — which is worse than useless, because the
   duplicate then has to be spotted and refunded.

   So:
     unpaid            → the pay-to details, as always
     paid via the link → the Razorpay reference, which is what a receipt is for
     paid by hand      → just PAID; there is no reference to show

   Mirrored by payBlock() in public/app.js for the on-screen preview and the
   thermal receipt, which render from form state rather than from a row. */
export function paymentBlock(inv) {
  const paid = String(inv.status || "").toUpperCase() === "PAID";
  if (!paid) return { kind: "payto", label: "Pay To", lines: payToLines(inv) };

  const lines = [];
  if (inv.rzp_payment_id) {
    lines.push("Paid online via Razorpay");
    lines.push(`Ref ${inv.rzp_payment_id}`);
  }
  if (inv.paid_at) lines.push(fmtPaidDate(inv.paid_at));
  return { kind: "paid", label: "Paid", lines };
}

export const payToLines = (inv) =>
  String(inv.biz_pay || "").split(/\n|,\s*/).map((s) => s.trim()).filter(Boolean);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* "12 Aug 2026", from either a stored "YYYY-MM-DD" or epoch ms.

   Built by hand rather than with toLocaleDateString because both inputs have a
   trap. A locale-formatted date puts 11/08 or 08/11 depending on where it is
   read, and an invoice is a record — that ambiguity is not acceptable on one.
   And `new Date("2026-08-12")` parses as UTC midnight, so in any timezone west
   of Greenwich formatting it locally prints the previous day. */
export function fmtDate(value) {
  if (value == null || value === "") return "";

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (iso) {
    const [, y, m, d] = iso;
    const mi = Number(m) - 1;
    if (mi < 0 || mi > 11) return String(value);
    return `${Number(d)} ${MONTHS[mi]} ${y}`;
  }

  const ms = Number(value);
  if (!Number.isFinite(ms)) return String(value);
  const dt = new Date(ms);
  if (!Number.isFinite(dt.getTime())) return "";
  // Epoch ms is an instant; render it in UTC so the same invoice never shows
  // two different dates to two people.
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

// Kept as a name of its own because the paid date is an instant (epoch ms) while
// issue/due are calendar dates; fmtDate handles both, this just says which.
export const fmtPaidDate = fmtDate;

/* ── amount in words ─────────────────────────────────────────────────────────

   Standard on an Indian invoice, and not decoration: it is the check against a
   figure being altered after issue, which is why it is written out.

   Indian numbering, not western — the groups are crore, lakh, thousand, then
   hundreds, so 1234567 reads "Twelve Lakh Thirty Four Thousand Five Hundred
   Sixty Seven", never "One Million Two Hundred...". */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
  "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

function threeDigits(n) {
  const h = Math.floor(n / 100), rest = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

// The integer part only, in the Indian grouping.
export function numberToWords(n) {
  let num = Math.floor(Math.abs(Number(n) || 0));
  if (num === 0) return "Zero";

  const parts = [];
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000);    num %= 100000;
  const thousand = Math.floor(num / 1000);  num %= 1000;

  // Each group is itself at most three digits, except crore which can run
  // higher — "One Hundred Twenty Crore" is correct, so it recurses.
  if (crore) parts.push(`${crore > 999 ? numberToWords(crore) : threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (num) parts.push(threeDigits(num));
  return parts.join(" ");
}

/* The full line: "Rupees Six Thousand Eight Hundred Sixty Eight Only".

   Only for ₹ — writing amounts out this way is an Indian convention, and
   "Dollars ... Only" on a USD invoice would look like a mistake rather than a
   nicety. Returns "" for anything else, and the callers omit the row. */
export function amountInWords(total, currency) {
  if ((currency || "₹") !== "₹") return "";
  const n = Number(total) || 0;
  // Round ONCE to paise, then split. Flooring the rupees separately from the
  // rounded paise makes 99.999 read "Ninety Nine ... Only" while the figure
  // beside it prints 100.00 — the exact disagreement this row exists to catch.
  const totalPaise = Math.round(Math.abs(n) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  const sign = n < 0 ? "Minus " : "";
  const head = `${sign}Rupees ${numberToWords(rupees)}`;
  return paise
    ? `${head} and ${twoDigits(paise)} Paise Only`
    : `${head} Only`;
}

/* ── place of supply ─────────────────────────────────────────────────────────

   Required on a GST invoice. The first two digits of a GSTIN are the state
   code, which is what the app already uses to decide CGST+SGST vs IGST — this
   puts the conclusion on the document instead of leaving it implied. */
const GST_STATES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
  "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", 10: "Bihar", 11: "Sikkim",
  12: "Arunachal Pradesh", 13: "Nagaland", 14: "Manipur", 15: "Mizoram",
  16: "Tripura", 17: "Meghalaya", 18: "Assam", 19: "West Bengal",
  20: "Jharkhand", 21: "Odisha", 22: "Chhattisgarh", 23: "Madhya Pradesh",
  24: "Gujarat", 25: "Daman & Diu", 26: "Dadra & Nagar Haveli and Daman & Diu",
  27: "Maharashtra", 28: "Andhra Pradesh", 29: "Karnataka", 30: "Goa",
  31: "Lakshadweep", 32: "Kerala", 33: "Tamil Nadu", 34: "Puducherry",
  35: "Andaman & Nicobar Islands", 36: "Telangana", 37: "Andhra Pradesh",
  38: "Ladakh", 97: "Other Territory",
};

// "Karnataka (29)", or "" when there is no GSTIN to derive it from — an invented
// place of supply would be worse than none.
export function placeOfSupply(inv) {
  const code = String(inv.client_gst || "").trim().slice(0, 2);
  if (!/^\d{2}$/.test(code)) return "";
  const name = GST_STATES[code] || GST_STATES[Number(code)];
  return name ? `${name} (${code})` : "";
}

// "Ledger desk" email — mirrors the on-screen invoice: warm-neutral sheet,
// pine-green ink, monospaced ledger figures, a double-rule grand total.
// Email-safe: inline styles + table layout, no <style>/@page. Figures use a
// mono stack with graceful fallback (some clients strip webfonts).
const MONO = "'IBM Plex Mono','SF Mono',Consolas,monospace";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const GREEN = "#2f7d54";
const INK = "#1b1e24";
const SOFT = "#5b6472";
const RULE = "#e7e9e6";

// The logo is stored as a data: URI — the Settings page reads the uploaded file
// with readAsDataURL and keeps it on the user row. That renders fine in a browser
// and is why the on-screen invoice and the PDF have always looked right.
//
// EMAIL CLIENTS STRIP data: IMAGES. Gmail, Outlook and Apple Mail all refuse
// them (they are a classic tracking and payload vector), so the invoice email
// showed a broken-image icon where the logo should be.
//
// The fix is CID: send the image bytes as an attachment and reference it as
// <img src="cid:...">. Supported by every mail client — it predates HTML email —
// and by Resend via the attachment's content_id field. No hosting, no remote
// fetch, and no "click to show images" prompt, which is the flaw in linking to a
// hosted URL instead.
//
// Returns { attachment, src } or null when there is no usable logo.
export function logoAttachment(dataUri) {
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/i
    .exec(String(dataUri || "").trim());
  if (!m) return null;

  // Resend caps attachments at 40MB and a logo is a few KB. Anything larger than
  // this is not a logo, and quietly refusing beats sending a broken email.
  const base64 = m[3];
  if (base64.length > 2_000_000) return null;

  const ext = m[2].toLowerCase().replace("jpeg", "jpg");
  const cid = "logo@invoicer";
  return {
    src: `cid:${cid}`,
    attachment: {
      filename: `logo.${ext}`,
      content: base64,
      content_id: cid,
      content_type: m[1],
    },
  };
}

/* The order-online QR, as a CID attachment.

   Same reasoning as logoAttachment above: mail clients strip data: URIs, so the
   pixels have to travel as an attachment. This is the one surface that needs a
   raster at all — both PDFs draw the modules as vectors — which is why qr.js
   carries a small PNG encoder.

   Returns { attachment, src } or null when this business has no shop link. */
export function qrAttachment(inv) {
  const content = qrPngBase64(qrMatrix(inv && inv.qr_url), 6);
  if (!content) return null;

  const cid = "orderqr@invoicer";
  return {
    src: `cid:${cid}`,
    attachment: {
      filename: "order-qr.png",
      content,
      content_id: cid,
      content_type: "image/png",
    },
  };
}

/* The signature, as a CID attachment.

   Same CID mechanism as the logo and the QR — mail clients strip data: URIs.
   The stored value is a 1-bit mask rather than an image, so the pixels are
   built here with the encoder in bitmap.js.

   Returns null when the business has no signature, which is also what keeps
   this off the public pay page: sharePage never asks for one. */
export function signAttachment(inv) {
  const content = signPngBase64(inv && inv.biz_sign);
  if (!content) return null;

  const cid = "signature@invoicer";
  return {
    src: `cid:${cid}`,
    attachment: {
      filename: "signature.png",
      content,
      content_id: cid,
      content_type: "image/png",
    },
  };
}

// `logoSrc` overrides what the <img> points at, so the same template serves both
// the email (a cid: reference) and any browser context (the data: URI as before).
// Defaulting to inv.biz_logo keeps every existing caller working unchanged.
// `payUrl` adds a Pay button to the emailed copy. Optional and last, so every
// existing caller (ingest.js, emailInvoice, and the public pay page — which has
// its own button and must NOT get a second one) is unaffected by its addition.
export function renderInvoiceEmail(inv, items, logoSrc = null, payUrl = null, qrSrc = null,
                                   signSrc = null) {
  const cur = inv.currency || "₹";
  const t = computeTotals(inv, items);
  const initial = (inv.biz_name || "I").charAt(0).toUpperCase();
  const discPct = inv.discount_pct || 0;
  const logo = logoSrc ?? inv.biz_logo;

  const rows = items.filter((i) => i.description || i.qty || i.rate).map((i) => {
    const amt = (i.qty || 0) * (i.rate || 0);
    return `<tr>
      <td style="padding:11px 10px;border-bottom:1px solid ${RULE};font-weight:600">${esc(i.description)}</td>
      <td align="right" style="padding:11px 10px;border-bottom:1px solid ${RULE};font-family:${MONO};color:${SOFT}">${i.qty || ""}</td>
      <td align="right" style="padding:11px 10px;border-bottom:1px solid ${RULE};font-family:${MONO};color:${SOFT}">${plain(cur, i.rate)}</td>
      <td align="right" style="padding:11px 10px;border-bottom:1px solid ${RULE};font-family:${MONO}">${money(cur, amt)}</td></tr>`;
  }).join("");

  const totRow = (label, val, opts = {}) =>
    `<tr><td style="padding:6px 10px;color:${SOFT}${opts.strong ? `;font-weight:600;color:${INK}` : ""}">${esc(label)}</td>
      <td align="right" style="padding:6px 10px;font-family:${MONO};color:${opts.strong ? INK : SOFT}">${opts.neg ? "– " : opts.pos ? "+ " : ""}${money(cur, val)}</td></tr>`;

  const taxRows = t.taxRows.map(([l, v]) => totRow(l, v)).join("");
  const pay = paymentBlock(inv);
  const pos = placeOfSupply(inv);
  const words = amountInWords(t.total, cur);
  const units = itemUnits(items);

  /* "Scan for other products and order online".

     The link is spelled out beside the QR rather than left implicit in it. This
     copy is read on a phone as often as on paper, and scanning a code with the
     device already holding it is awkward — so whoever is reading gets something
     tappable, and whoever printed it gets something scannable.

     Rendered only when the business carries a shop link, so the businesses that
     have no shop send exactly the email they sent before. */
  const qrImg = qrSrc || "";
  const orderQr = inv.qr_url
    ? `<table cellpadding="0" cellspacing="0" style="margin-top:28px">
        <tr>
         ${qrImg ? `<td valign="middle" style="padding-right:14px">
           <img src="${esc(qrImg)}" width="104" height="104" alt="Scan to order online"
                style="display:block;border:1px solid ${RULE};border-radius:6px"></td>` : ""}
         <td valign="middle">
           <div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${SOFT};font-weight:700">Order online</div>
           <div style="font-size:11.5px;color:${INK};margin-top:3px">${esc(String(inv.qr_caption || "").trim() || "Scan for more products & order online")}</div>
           <a href="${esc(inv.qr_url)}" style="font-size:11px;color:${GREEN};word-break:break-all">${esc(inv.qr_url)}</a>
         </td></tr>
       </table>`
    : "";

  // Only on an unpaid invoice: a Pay button on a settled one invites a second
  // payment. A bulletproof <a>, not a <button> — mail clients do not run scripts.
  const payButton = payUrl && String(inv.status || "").toUpperCase() !== "PAID"
    ? `<div style="margin-top:26px;text-align:center">
         <a href="${esc(payUrl)}" style="display:inline-block;background:${GREEN};color:#fff;text-decoration:none;padding:13px 30px;border-radius:9px;font-weight:700;font-size:15px">Pay ${money(cur, t.total)}</a>
         <div style="margin-top:9px;font-size:11px;color:${SOFT}">or view this invoice online: <a href="${esc(payUrl)}" style="color:${GREEN}">${esc(payUrl)}</a></div>
       </div>`
    : "";

  return `<div style="font-family:${SANS};color:${INK};max-width:640px;margin:0 auto;padding:8px">
  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid ${INK};padding-bottom:14px">
   <tr><td valign="top" style="padding:16px 0">
     ${logo
      ? `<img src="${esc(logo)}" alt="${esc(inv.biz_name || "Logo")}" style="max-width:150px;max-height:60px;display:block;margin-bottom:10px">`
      : `<span style="display:inline-block;width:44px;height:44px;background:${GREEN};color:#fff;font-family:${MONO};font-size:21px;font-weight:600;text-align:center;line-height:44px;border-radius:9px">${esc(initial)}</span>`}
     <div style="margin-top:9px"><b style="font-size:18px">${esc(inv.biz_name || "Your Business")}</b><br>
     <span style="color:${SOFT};font-size:12px">${esc(inv.biz_addr)}<br>${[inv.biz_phone, inv.biz_email].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ")}</span></div>
   </td>
   <td align="right" valign="top" style="padding:16px 0">
     <div style="font-size:24px;font-weight:700;color:${GREEN};letter-spacing:4px">INVOICE</div>
     <div style="font-size:12px;color:${SOFT};margin-top:8px">
       No. <b style="font-family:${MONO};color:${INK}">${esc(inv.number)}</b><br>
       Issued <b style="font-family:${MONO};color:${INK}">${esc(fmtDate(inv.issue_date))}</b>${inv.due_date ? `<br>Due <b style="font-family:${MONO};color:${INK}">${esc(fmtDate(inv.due_date))}</b>` : ""}
     </div>
   </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;font-size:12px">
   <tr><td valign="top" width="58%">
     <div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${SOFT};font-weight:700">Billed To</div>
     <b style="font-size:13px">${esc(inv.client_name || "Client")}</b><br><span style="color:${SOFT}">${esc(inv.client_addr)}<br>${esc(inv.client_email)}${inv.client_gst ? "<br>GSTIN: " + esc(inv.client_gst) : ""}${pos ? `<br>Place of supply: ${esc(pos)}` : ""}</span>
   </td>
   <td valign="top" align="right">
     <div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${pay.kind === "paid" ? GREEN : SOFT};font-weight:700">${esc(pay.label)}</div>
     <span style="color:${SOFT}">${pay.lines.map(esc).join("<br>")}${pay.lines.length && inv.biz_gst ? "<br>" : ""}${inv.biz_gst ? "GSTIN: " + esc(inv.biz_gst) : ""}</span>
   </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
   <tr style="color:${SOFT};font-size:9.5px;text-transform:uppercase;letter-spacing:1px">
    <td style="padding:8px 10px;border-bottom:2px solid ${INK}">Description</td>
    <td align="right" style="padding:8px 10px;border-bottom:2px solid ${INK}">Qty</td>
    <td align="right" style="padding:8px 10px;border-bottom:2px solid ${INK}">Rate</td>
    <td align="right" style="padding:8px 10px;border-bottom:2px solid ${INK}">Amount</td></tr>
   ${rows}
  </table>
  <table align="right" cellpadding="0" cellspacing="0" style="margin-top:16px;font-size:12px;width:56%">
   ${units ? `<tr><td style="padding:6px 10px;color:${SOFT}">Items</td>
      <td align="right" style="padding:6px 10px;font-family:${MONO};color:${SOFT}">${esc(fmtUnits(units))}</td></tr>` : ""}
   ${totRow("Subtotal", t.subtotal)}
   ${t.disc ? totRow(`Discount (${discPct}%)`, t.disc, { neg: true }) : ""}
   ${t.shipping ? totRow(inv.shipping_mode ? `Shipping (${inv.shipping_mode})` : "Shipping", t.shipping) : ""}
   ${(t.disc || t.shipping) && t.taxRows.length ? totRow("Taxable value", t.taxable) : ""}
   ${taxRows}
   ${showRoundOff(t) ? totRow("Round off", Math.abs(t.round), { neg: t.round < 0, pos: t.round > 0 }) : ""}
   <tr><td style="padding:12px 10px 6px;border-top:3px double ${RULE};font-family:${SANS};font-weight:700;text-transform:uppercase;letter-spacing:.6px">Total ${cur ? `(${esc(cur)})` : ""}</td>
       <td align="right" style="padding:12px 10px 6px;border-top:3px double ${RULE};font-family:${MONO};font-weight:600;font-size:18px;color:${GREEN}">${money(cur, t.total)}</td></tr>
  </table>
  <div style="clear:both"></div>
  ${words ? `<div style="margin-top:14px;font-size:11px;color:${SOFT};max-width:62%">
     <span style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;font-weight:700">Amount in words</span><br>
     <span style="color:${INK}">${esc(words)}</span></div>` : ""}
  ${payButton}
  ${inv.notes ? `<div style="margin-top:28px;font-size:11px;color:${SOFT};white-space:pre-line"><div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${SOFT};font-weight:700;margin-bottom:4px">Notes / Terms</div>${esc(inv.notes)}</div>` : ""}
  ${orderQr}
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:34px">
   <tr><td align="right">
     <div style="display:inline-block;min-width:190px;text-align:center">
       ${signSrc ? `<img src="${esc(signSrc)}" alt="" height="46"
            style="display:block;margin:0 auto -6px;max-width:180px">` : ""}
       <div style="border-top:1px solid ${RULE};padding-top:6px;font-size:10px;color:${SOFT}">
         For ${esc(inv.biz_name || "Your Business")}<br>Authorised Signatory</div>
     </div>
   </td></tr>
  </table>
  <div style="margin-top:22px;text-align:center;color:${SOFT};font-size:10px;font-family:${MONO};letter-spacing:.3px;border-top:1px solid ${RULE};padding-top:13px">${esc([inv.biz_name, inv.biz_phone, inv.biz_email].filter(Boolean).join(" · "))}</div>
 </div>`;
}
