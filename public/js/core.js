/* Invoicer — client-side generator.
   No backend required: business profile persists in localStorage,
   PDF via the browser print engine. API hooks (save/email) added later.

   Split into ten classic scripts on 29 Sep 2026 (one 2,771-line app.js before).
   index.html loads them in this order, and the order matters: they share one
   global scope, exactly as the single file did, so a later file may call
   anything declared earlier and each file's top-level code runs as it loads.
   core.js → money.js → render.js → assets.js → profile.js → init.js → export.js → receipt.js → backend.js → modals.js
   Every file starts with "use strict", as the single file did. */
"use strict";

const $ = (id) => document.getElementById(id);
const BIZ_KEY = "invoicer.biz.v1";
const LOGIN_EMAIL_KEY = "invoicer.loginEmail.v1"; // last sign-in identity (≠ business email)

// Fields that make up the reusable "your business" profile.
const BIZ_FIELDS = ["bizName","bizEmail","bizAddr","bizPhone","bizGst","bizUdyam","bizPay"];

// Optional business logo (data-URL). Not a form <input>, so it's tracked
// separately from BIZ_FIELDS and persisted alongside them.
let BIZ_LOGO = "";

// The authorised signatory's signature, as a 1-bit mask ("<w>:<h>:<base64>").
// Same deal as the logo — uploaded, not typed, so it lives here rather than in
// BIZ_FIELDS. See fileToSignature() for why it is a mask and not an image.
let BIZ_SIGN = "";

/* The account's businesses, and which one is filling the form.

   One account, several trading names — AswinCloud and Aswin3DPrints — each with
   its own identity, its own invoice-number prefix, its own tax defaults and
   optionally a shop link printed as a QR.

   BIZ_LIST entries are the shape publicBusiness() sends: {id, isDefault, biz,
   defaults, qrRows}. `qrRows` is the QR already encoded server-side — the
   browser never builds one, because it cannot import src/qr.js and a second
   encoder is a second thing to keep in step. */
let BIZ_LIST = [];
let ACTIVE_BIZ = null;
let BIZ_QR_CAPTION = "";

const activeBiz = () => BIZ_LIST.find((b) => b.id === ACTIVE_BIZ) || BIZ_LIST[0] || null;

/* The QR modules for the receipt, or null when this business has no shop link.
   Read from the form's URL field so the preview reacts as it is typed, but the
   MODULES only exist for a saved URL — encoding happens on the server. */
/* The static "scan to pay" QR, or null.

   Encoded server-side from the business's UPI address, so — exactly like the
   order QR — a VPA typed but not yet saved prints nothing rather than a stale
   code. And only while the invoice is actually payable: PAID must not invite a
   second payment and VOID must not invite a first, the same rule paymentBlock
   and payability() apply. */
function payQrRows(){
  const st = fld("status").toUpperCase();
  if(st === "PAID" || st === "VOID") return null;
  // The per-invoice switch. Off means no pay QR on this receipt even while
  // unpaid - a quote, or a bill being settled in cash at the counter. Mirrors
  // wantsPayQr() server-side, which does the same for the PDF and the email.
  if(!$("payQrOn").checked) return null;
  const b = activeBiz();
  if(!b || !b.payQrRows) return null;
  // Either input, edited but not yet saved, means the shipped matrix is stale —
  // and a stale pay QR points at the PREVIOUS payee, which is the one mistake
  // here that costs money.
  if(fld("bizUpiVpa") !== (b.biz.upiVpa || "")) return null;
  if(fld("bizPayQr") !== (b.biz.payQr || "")) return null;
  return b.payQrRows;
}

/* The address to PRINT beside the pay QR — which is not always the address the
   QR encodes, and deliberately so.

   A provider's QR carries a machine-generated payee:
   "merchant123456.rzp@exbank", 29 opaque characters. On paper the only thing
   a person can do with that is type it, and a mistyped VPA does not bounce — it
   pays whoever does own that address. So it is not printed. Nothing is lost:
   the payload's own `tn` means the payer's app shows who they are paying, which
   is a better confirmation than a line of text on a receipt anyway.

   An address the user typed themselves is different — "9000000000@examplebank" is
   short, theirs, and a genuine fallback for a customer whose camera will not
   focus. That one prints.

   Email keeps showing either, because there you can copy it. This asymmetry is
   the point: paper cannot be copied. */
const GIFT_LABEL = "Amazon Pay Gift Card";
// Mirrors GIFT_MIN / GIFT_MAX in src/invoice-html.js. The exact value is stored
// but never printed — the card is a surprise.
const GIFT_MIN = 1, GIFT_MAX = 500;

/* The gift card on this invoice, or null. Mirrors giftBlock() in
   src/invoice-html.js — the receipt and the preview render from FORM state, so
   the rule lives twice, the same way payBlock mirrors paymentBlock.

   A present, not a payment: nothing here touches computeTotals. The checkbox
   gates it so a code left in the box does not print once it is unticked. */
function giftOnInvoice(){
  if(!$("giftOn").checked) return null;
  const code = fld("giftCode");
  if(!code) return null;
  return { code, amount: +$("giftAmount").value || 0, label: GIFT_LABEL };
}

// Grey the fields out when the box is unticked, so it is obvious the code in
// them is not going anywhere.
function syncGift(){
  const on = $("giftOn").checked;
  ["giftCode","giftAmount"].forEach(f => { $(f).disabled = !on; });
}

function payeeFromPayQr(){
  const b = activeBiz();
  // A pasted provider payload — printing its payee helps nobody.
  if(fld("bizPayQr") || (b && b.biz.payQr)) return "";
  return fld("bizUpiVpa");
}

function activeQrRows(){
  const b = activeBiz();
  if(!b || !b.qrRows) return null;
  // The field can be edited without saving; a stale matrix for a different URL
  // would print a QR pointing somewhere the user has just changed away from.
  if(fld("bizQrUrl") !== (b.biz.qrUrl || "")) return null;
  return b.qrRows;
}

/* The Razorpay reference for the invoice currently loaded in the editor.

   The preview and the thermal receipt render from FORM state, and the payment
   reference is not a form field — it is written by the webhook, not typed. So it
   is carried here when a saved invoice is opened.

   `number` is kept alongside it as a guard. "Save" always inserts a NEW invoice
   row, so opening a paid invoice, editing it and saving produces a fresh unpaid
   one; without checking the number still matches, that new invoice would print
   somebody else's payment reference. */
let PAY_REF = null;                       // { number, id, at } | null

/* The invoice currently open in the editor, or null for a new one.

   Without this, Save and Email had no way to say "the one I opened" — both
   POSTed, so every press CREATED an invoice. That is how production ended up
   with 25 invoices under 14 numbers, including three copies of one marked PAID
   at three different amounts.

   Adopted after a successful create too, so the second press of Save updates
   the invoice the first press made. */
let CURRENT_ID = null;

/* Ask the server for an invoice number it is not already using.

   The number stays PREFIX-YEAR-<4 random digits> — sequential numbering would
   tell a customer how many invoices have been issued — but 4 digits is 9000
   slots, and picking blind collided two unrelated invoices in production
   already. Falls back to a local guess if the call fails: an unchecked number
   is better than a blank field, and the unique index catches it on save. */
async function freshInvoiceNumber(){
  try {
    // The prefix belongs to the business, not the account: 3DPrints numbers
    // INV-3DP-… while AswinCloud numbers INV-AC-…. Sent explicitly so the
    // number matches the business currently filling the form, rather than
    // whichever one the account happens to default to.
    const b = activeBiz();
    const pre = b && b.defaults && b.defaults.prefix ? b.defaults.prefix : "";
    const r = await api("/invoices/next-number" + (pre ? "?prefix=" + encodeURIComponent(pre) : ""));
    if(r && r.number) return r.number;
  } catch(_){ /* offline or signed out — fall through */ }
  return "INV-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random()*9000)+1000);
}

// Mirrors paymentBlock() in src/invoice-html.js — same rule, applied to the form
// rather than to a database row. A settled invoice shows how it was paid, never
// how to pay it.
// render() and the receipt builder each declare their own local `v`, so these
// module-level helpers need their own field accessor.
const fld = (id) => ($(id)?.value || "").trim();

function payBlock(){
  const paid = fld("status").toUpperCase() === "PAID";
  if(!paid) return { paid:false, label:"Pay To", lines: payToLines() };

  const ref = PAY_REF && PAY_REF.number === fld("invNo") ? PAY_REF : null;
  const lines = [];
  if(ref && ref.id){ lines.push("Paid online via Razorpay"); lines.push("Ref " + ref.id); }
  if(ref && ref.at) lines.push(fmtPaidDate(ref.at));
  return { paid:true, label:"Paid", lines };
}

const payToLines = () =>
  fld("bizPay").split(/\r?\n|,\s*/).map(s => s.trim()).filter(Boolean);

/* Mirrors fmtDate / plain / amountInWords / placeOfSupply in
   src/invoice-html.js. The browser cannot import the Worker module, so the rules
   live twice — test/invoice-words.mjs pins the server side, and any change here
   must be made there too. */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/* "12 Aug 2026" from a stored "YYYY-MM-DD" or from epoch ms.

   Not toLocaleDateString: it prints 11/08 or 08/11 depending on the device, and
   an invoice is a record. And `new Date("2026-08-12")` is UTC midnight, so
   formatting it locally shows the previous day anywhere west of Greenwich. */
function fmtDate(value){
  if(value == null || value === "") return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if(iso){
    const mi = Number(iso[2]) - 1;
    if(mi < 0 || mi > 11) return String(value);
    return `${Number(iso[3])} ${MONTHS[mi]} ${iso[1]}`;
  }
  const d = new Date(Number(value));
  if(isNaN(d.getTime())) return String(value);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const fmtPaidDate = fmtDate;

// The figure without the currency symbol, for the Rate column — which sits
// beside Amount, so the two must group identically.
function plainNum(n){
  const cur = $("currency").value;
  return Number(n||0).toLocaleString(cur === "₹" ? "en-IN" : "en-US",
    {minimumFractionDigits:2, maximumFractionDigits:2});
}

const ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
  "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
const TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
const two=(n)=> n<20 ? ONES[n] : (ONES[n%10] ? `${TENS[Math.floor(n/10)]} ${ONES[n%10]}` : TENS[Math.floor(n/10)]);
function three(n){
  const h=Math.floor(n/100), r=n%100, out=[];
  if(h) out.push(`${ONES[h]} Hundred`);
  if(r) out.push(two(r));
  return out.join(" ");
}
// Indian grouping: crore, lakh, thousand — 1234567 is "Twelve Lakh …", never
// "One Million …".
function numberToWords(n){
  let num=Math.floor(Math.abs(Number(n)||0));
  if(num===0) return "Zero";
  const parts=[];
  const cr=Math.floor(num/10000000); num%=10000000;
  const la=Math.floor(num/100000);   num%=100000;
  const th=Math.floor(num/1000);     num%=1000;
  if(cr) parts.push(`${cr>999?numberToWords(cr):three(cr)} Crore`);
  if(la) parts.push(`${three(la)} Lakh`);
  if(th) parts.push(`${three(th)} Thousand`);
  if(num) parts.push(three(num));
  return parts.join(" ");
}
// ₹ only: writing the amount out is an Indian convention, and "Dollars … Only"
// would read as a mistake.
function amountInWords(total, currency){
  if((currency||"₹") !== "₹") return "";
  const n=Number(total)||0;
  // Round ONCE, then split — flooring rupees separately from rounded paise makes
  // 99.999 read "Ninety Nine" beside a printed 100.00.
  const tp=Math.round(Math.abs(n)*100);
  const rupees=Math.floor(tp/100), paise=tp%100;
  const head=`${n<0?"Minus ":""}Rupees ${numberToWords(rupees)}`;
  return paise ? `${head} and ${two(paise)} Paise Only` : `${head} Only`;
}

const GST_STATES={ "01":"Jammu & Kashmir","02":"Himachal Pradesh","03":"Punjab",
  "04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan",
  "09":"Uttar Pradesh","10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh",
  "13":"Nagaland","14":"Manipur","15":"Mizoram","16":"Tripura","17":"Meghalaya",
  "18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh",
  "23":"Madhya Pradesh","24":"Gujarat","25":"Daman & Diu",
  "26":"Dadra & Nagar Haveli and Daman & Diu","27":"Maharashtra","28":"Andhra Pradesh",
  "29":"Karnataka","30":"Goa","31":"Lakshadweep","32":"Kerala","33":"Tamil Nadu",
  "34":"Puducherry","35":"Andaman & Nicobar Islands","36":"Telangana",
  "37":"Andhra Pradesh","38":"Ladakh","97":"Other Territory" };

/* What the document is actually called.

   "TAX INVOICE" was hardcoded on the receipt, and it is not a decoration: under
   GST it is the document a REGISTERED supplier issues when charging tax. A
   supply without tax is a Bill of Supply, and a business with no GSTIN issues
   neither — it issues an invoice.

   Derived rather than pinned to a setting, so it cannot go stale: with no GSTIN
   this reads "INVOICE" today, and starts telling the truth on its own if a
   GSTIN is ever filled in. */
function docTitle(){
  if(!fld("bizGst")) return "INVOICE";
  return $("taxMode").value === "none" ? "BILL OF SUPPLY" : "TAX INVOICE";
}

/* Units in the box — the sum of the quantities, not the number of lines.

   That is what a till receipt means by "items": eight lines and twenty-one
   units are both true of one invoice, and only the second can be checked
   against what the customer is holding.

   Negative-amount lines are skipped, because a promo discount is modelled as a
   line item with qty 1 and a negative rate (see ingest.js) and is not goods.

   Mirrors itemUnits() in src/invoice-html.js. */
function itemUnits(items){
  return (items||[]).reduce((n,i)=>{
    const qty = Number(i.qty)||0;
    return qty * (Number(i.rate)||0) < 0 ? n : n + qty;
  }, 0);
}
const fmtUnits = (n) => Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));

// Required on a GST invoice; the first two digits of the client's GSTIN are the
// state code. Empty when there is no GSTIN — an invented place of supply would
// be worse than none.
function placeOfSupplyFromGst(gstin){
  const code=String(gstin||"").trim().slice(0,2);
  if(!/^\d{2}$/.test(code)) return "";
  return GST_STATES[code] ? `${GST_STATES[code]} (${code})` : "";
}
// All fields we re-render the preview from.
// The QR pair sit beside BIZ_FIELDS rather than in it: BIZ_FIELDS is the set of
// plain text fields copied verbatim between the form, localStorage and the
// account, and these two need the extra step of being re-encoded server-side
// before they can be printed.
const BIZ_QR_FIELDS = ["bizQrUrl","bizQrCaption","bizUpiVpa","bizPayQr"];

const ALL_FIELDS = [...BIZ_FIELDS,"clName","clEmail","clPhone","clAddr","clGst",
  "invNo","currency","issueDate","dueDate","discount","taxMode","taxRate",
  "shipping","shippingMode","shippingModeOther","packaging","packagingLabel","status","notes"];

