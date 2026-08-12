// A free line must say it is free.
//
// A zero price used to render as an empty cell while the Amount column beside
// it printed 0.00 — so one row contradicted itself, and the blank read as data
// somebody forgot to enter rather than as a deliberate zero. On an invoice that
// distinction matters: "free" and "we forgot to price this" are different
// conversations with a customer.

import { renderInvoiceEmail, computeTotals, plain } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

const INV = { number: "INV-1", currency: "₹", tax_mode: "none", biz_name: "B" };
const ITEMS = [
  { description: "Paid item", qty: 2, rate: 450 },
  { description: "Free sample", qty: 1, rate: 0 },
];

console.log("— the formatter itself —");
check("zero formats as 0.00", plain("₹", 0) === "0.00", plain("₹", 0));
check("zero is not blank", plain("₹", 0) !== "");
check("undefined still formats", plain("₹", undefined) === "0.00", plain("₹", undefined));

console.log("\n— email —");
const html = renderInvoiceEmail(INV, ITEMS);
const rows = [...html.matchAll(
  /<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g)]
  .map((m) => m.slice(1).map((s) => s.trim()));
for (const r of rows) console.log("   ", JSON.stringify(r));

const free = rows.find((r) => r[0] === "Free sample");
check("the free line appears at all", Boolean(free));
check("its rate is 0.00, not blank", free && free[2] === "0.00", free && JSON.stringify(free[2]));
check("its amount is 0.00", free && free[3].includes("0.00"), free && free[3]);
check("the paid line is untouched", rows[0][2] === "450.00", rows[0][2]);

console.log("\n— PDF —");
const pdf = new TextDecoder("latin1")
  .decode(renderInvoicePdf(INV, ITEMS, computeTotals(INV, ITEMS)));
check("PDF prints a 0.00 rate", pdf.includes("(0.00)"), "");
check("PDF still prints the paid rate", pdf.includes("(450.00)"));

console.log("\n— a whole invoice of free items —");
const allFree = [{ description: "Gift", qty: 1, rate: 0 }];
const h2 = renderInvoiceEmail(INV, allFree);
check("renders without collapsing", h2.includes("Gift"));
check("total reads 0.00", h2.includes("0.00"));
check("computeTotals agrees", computeTotals(INV, allFree).total === 0);

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
