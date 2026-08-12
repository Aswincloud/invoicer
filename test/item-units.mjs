// The "Items" count on an invoice.
//
// It counts UNITS, not lines. That distinction is the whole point: a customer
// can check 21 against what they were handed; they cannot check 8 without
// reading the invoice back to themselves.

import { itemUnits, fmtUnits, renderInvoiceEmail } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";
import { computeTotals } from "../src/invoice-html.js";

let failed = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failed++; }
};

// The real invoice this was built for: 8 lines, 21 units.
const SIX142 = [
  { description: "Straight staircase", qty: 2, rate: 220.14 },
  { description: "Spiral staircase", qty: 2, rate: 330.2 },
  { description: "Miniature Plants", qty: 7, rate: 27.6 },
  { description: "Bottles and glasses", qty: 6, rate: 16.57 },
  { description: "Rectangular tray", qty: 1, rate: 21.74 },
  { description: "Curcular tray", qty: 1, rate: 21.74 },
  { description: "Tree bark + lantern", qty: 1, rate: 71.42 },
  { description: "Wall Hanger", qty: 1, rate: 21.24 },
];

console.log("— counting —");
eq("units, not lines", itemUnits(SIX142), 21);
eq("lines would have been 8", SIX142.length, 8);
eq("empty invoice", itemUnits([]), 0);
eq("undefined is not a crash", itemUnits(undefined), 0);
eq("single item", itemUnits([{ qty: 1, rate: 10 }]), 1);

console.log("\n— a promo discount is not goods —");
// ingest.js maps a shop discount to a line item with qty 1 and a negative rate.
// Counting it would overstate every discounted order by one.
eq("negative-rate line excluded",
  itemUnits([{ qty: 3, rate: 100 }, { description: "Discount (promo SAVE10)", qty: 1, rate: -300 }]), 3);
eq("a free item still counts", itemUnits([{ qty: 2, rate: 0 }]), 2);
eq("a negative QUANTITY (a return) is excluded too",
  itemUnits([{ qty: 5, rate: 10 }, { qty: -1, rate: 10 }]), 5);

console.log("\n— formatting —");
eq("whole numbers print bare", fmtUnits(21), "21");
eq("fractional quantity survives", fmtUnits(1.5), "1.5");
eq("float noise is trimmed", fmtUnits(0.1 + 0.2), "0.3");
eq("zero", fmtUnits(0), "0");

console.log("\n— it reaches the documents —");
const inv = { number: "INV-1", currency: "₹", tax_mode: "none", biz_name: "B" };
const html = renderInvoiceEmail(inv, SIX142);
eq("email has an Items row", /Items<\/td>/.test(html), true);
eq("email shows 21", /Items<\/td>[\s\S]{0,160}?>21</.test(html), true);

const pdfText = new TextDecoder("latin1")
  .decode(renderInvoicePdf(inv, SIX142, computeTotals(inv, SIX142)));
eq("PDF has an Items row", pdfText.includes("(Items)"), true);

// An invoice with no items must not print "Items 0" — there is nothing to count.
const empty = renderInvoiceEmail(inv, []);
eq("no items, no row", /Items<\/td>/.test(empty), false);

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
