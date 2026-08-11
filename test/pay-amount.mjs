// The charged amount must equal the rendered total, exactly, in every tax /
// discount / shipping / round-off combination.
//
// This is the one invariant where being wrong is worse than being broken: a
// client charged a rupee more than the invoice shows has a dispute, not a bug.
// Asserted against computeTotals directly, the way ingest.js asserts its
// transcription against the shop, rather than only through the HTTP layer.

import { computeTotals } from "../src/invoice-html.js";

// Must stay identical to paise() in src/pay.js.
const paise = (rupees) => Math.round(Number(rupees || 0) * 100);

const CASES = [
  { name: "plain, no tax",
    inv: { tax_mode: "none", tax_rate: 0 },
    items: [{ qty: 1, rate: 1000 }] },
  { name: "gst 18 split",
    inv: { tax_mode: "gst", tax_rate: 18 },
    items: [{ qty: 2, rate: 450 }, { qty: 1, rate: 1200 }] },
  { name: "single tax 12",
    inv: { tax_mode: "single", tax_rate: 12 },
    items: [{ qty: 3, rate: 99.9 }] },
  { name: "discount + shipping + gst",
    inv: { tax_mode: "gst", tax_rate: 18, discount_pct: 7.5, shipping: 100 },
    items: [{ qty: 1, rate: 1299 }] },
  { name: "round off on",
    inv: { tax_mode: "gst", tax_rate: 18, shipping: 100, round_off: 1 },
    items: [{ qty: 1, rate: 1100.03 }] },
  { name: "round off on, rounds down",
    inv: { tax_mode: "single", tax_rate: 5, round_off: 1 },
    items: [{ qty: 1, rate: 333.31 }] },
  { name: "floats that do not divide cleanly",
    inv: { tax_mode: "gst", tax_rate: 18, discount_pct: 23.0946 },
    items: [{ qty: 7, rate: 0.1 }, { qty: 3, rate: 0.2 }] },
  { name: "negative line item (a discount row)",
    inv: { tax_mode: "none", tax_rate: 0 },
    items: [{ qty: 1, rate: 1500 }, { qty: 1, rate: -300 }] },
];

let failed = 0;
for (const c of CASES) {
  const t = computeTotals(c.inv, c.items);
  const charged = paise(t.total);

  // What the client reads off the page is t.total formatted to 2dp. What the
  // card is debited is `charged`. They must be the same number.
  const rendered = Number(t.total.toFixed(2));
  const ok = charged === Math.round(rendered * 100) && Number.isInteger(charged);

  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(34)} total=${t.total} → ${charged} paise`);
  if (!ok) failed++;
}

// Razorpay rejects anything under 100 paise outright; pay.js must refuse before
// the round trip rather than surfacing their error to a client.
const tiny = computeTotals({ tax_mode: "none" }, [{ qty: 1, rate: 0.5 }]);
const tinyOk = paise(tiny.total) < 100;
console.log(`${tinyOk ? "PASS" : "FAIL"}  sub-₹1 invoice is detectable        ${paise(tiny.total)} paise`);
if (!tinyOk) failed++;

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
