// A gift card is a present, not money.
//
// Two things must hold, and both are the kind that go wrong quietly.
//
// It must not touch the arithmetic. A gift that shifted the subtotal, the
// taxable value or the total would put the invoice out of step with what the
// customer was actually charged — the failure ingest.js exists to prevent, and
// on a GST document it would also mean the wrong tax.
//
// And it must not appear on the PUBLIC pay page. That URL is the credential; a
// redeemable code on it belongs to whoever finds the link.

import { giftBlock, renderInvoiceEmail, computeTotals, GIFT_LABEL,
         GIFT_MIN, GIFT_MAX } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

const CODE = "AB1C-2DEF34-5GH6";
const BASE = { number: "INV-1", currency: "₹", tax_mode: "gst", tax_rate: 18,
               status: "UNPAID", biz_name: "Aswin3DPrints" };
const ITEMS = [{ description: "Benchy", qty: 2, rate: 250 }];

console.log("— the block itself —");
check("nothing without a code", giftBlock({ ...BASE }) === null);
check("nothing for an amount alone", giftBlock({ ...BASE, gift_amount: 100 }) === null,
  "a value with no code prints something unredeemable");
const g = giftBlock({ ...BASE, gift_code: CODE, gift_amount: 100 });
check("a code is enough", Boolean(g) && g.code === CODE);
check("carries the amount for the record", g.amount === 100);
check("and the range that gets printed instead", g.min === GIFT_MIN && g.max === GIFT_MAX);
check("names the brand once, from a constant", g.label === GIFT_LABEL, g.label);
check("whitespace-only code is nothing", giftBlock({ gift_code: "   " }) === null);

console.log("\n— it cannot move the money —");
const plain = computeTotals(BASE, ITEMS);
const gifted = computeTotals({ ...BASE, gift_code: CODE, gift_amount: 100 }, ITEMS);
for (const k of ["subtotal", "disc", "shipping", "taxable", "gross", "total"]) {
  check(`${k} identical with and without a gift`, plain[k] === gifted[k],
    `${plain[k]} vs ${gifted[k]}`);
}
check("tax rows identical", JSON.stringify(plain.taxRows) === JSON.stringify(gifted.taxRows));
check("a huge gift changes nothing",
  computeTotals({ ...BASE, gift_code: CODE, gift_amount: 999999 }, ITEMS).total === plain.total);

console.log("\n— email: only when asked —");
const inv = { ...BASE, gift_code: CODE, gift_amount: 100 };
const shown = renderInvoiceEmail(inv, ITEMS, { showGift: true });
check("prints the code", shown.includes(CODE));
check("prints the brand", shown.includes(GIFT_LABEL));
check("says it is not part of the bill", /not part of this bill/i.test(shown));

// The whole point of the range: the customer must not learn the figure from the
// receipt. A gift of 100 beside "Rs. 100" is not a surprise.
check("does NOT print the exact value", !/100\.00/.test(shown),
  "the card is a surprise; the figure stays on the invoice record");
check("prints the range instead", /random amount/i.test(shown) && shown.includes("500"));

// This is the mechanism that keeps it off /i/<token>: sharePage passes no
// showGift, so the default must be OFF rather than on.
const hidden = renderInvoiceEmail(inv, ITEMS);
check("DEFAULT is off — the public page passes nothing", !hidden.includes(CODE),
  "sharePage relies on this default");
check("and the brand is absent too", !hidden.includes(GIFT_LABEL));
check("the rest of the invoice still renders", hidden.includes("Benchy"));

console.log("\n— PDF: same gate —");
const t = computeTotals(inv, ITEMS);
const withGift = new TextDecoder("latin1").decode(renderInvoicePdf(inv, ITEMS, t, { showGift: true }));
const without = new TextDecoder("latin1").decode(renderInvoicePdf(inv, ITEMS, t));
check("prints the code when asked", withGift.includes(`(${CODE})`));
check("the A4 does not print the exact value either",
  !/\(100\.00\)/.test(withGift) && /random amount/i.test(withGift));
check("omits it by default", !without.includes(CODE));
check("both PDFs are still well-formed",
  withGift.startsWith("%PDF-") && withGift.includes("%%EOF")
  && without.startsWith("%PDF-") && without.includes("%%EOF"));
check("the totals printed on the PDF are unchanged by the gift",
  withGift.includes("(Rs. 590.00)") && without.includes("(Rs. 590.00)"),
  "2 x 250 + 18% GST");

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
