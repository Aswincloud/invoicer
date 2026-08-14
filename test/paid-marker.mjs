// An invoice settled by hand must still say it was paid.
//
// There are two ways an invoice gets settled, and only one of them leaves a
// reference behind:
//
//   online   the Razorpay webhook fills rzp_payment_id and paid_at, so the
//            document can print "Paid online via Razorpay / Ref pay_xxx"
//   by hand  cash or a UPI transfer at the counter, and someone sets the
//            status to PAID — there is nothing to print underneath
//
// The second case is the one that broke: code that decided whether to show the
// block by counting its detail lines found none and showed nothing, so a paid
// invoice carried no PAID marker. It also correctly suppresses the pay-to
// details, which together left a document saying nothing about payment at all —
// worse than either alone, because the customer cannot tell it is settled.

import { paymentBlock, renderInvoiceEmail, computeTotals } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

const BASE = {
  number: "INV-1", currency: "₹", tax_mode: "none", biz_name: "B",
  biz_pay: "UPI: aswin@okicici",
};
const ITEMS = [{ description: "Ceiling fan", qty: 1, rate: 2400 }];

const UNPAID = { ...BASE, status: "UNPAID" };
const BY_HAND = { ...BASE, status: "PAID" };
const ONLINE = { ...BASE, status: "PAID", rzp_payment_id: "pay_QwErTy123", paid_at: 1786000000000 };

console.log("— paymentBlock —");
const u = paymentBlock(UNPAID);
check("unpaid asks for payment", u.kind === "payto", u.kind);
check("unpaid carries the UPI id", u.lines.join(" ").includes("okicici"));

const h = paymentBlock(BY_HAND);
check("hand-paid is marked paid", h.kind === "paid", h.kind);
check("hand-paid is labelled", h.label.toUpperCase() === "PAID", h.label);
check("hand-paid has no reference to invent", h.lines.length === 0, JSON.stringify(h.lines));

const o = paymentBlock(ONLINE);
check("online is marked paid", o.kind === "paid");
check("online names Razorpay", o.lines.join(" ").includes("Razorpay"));
check("online prints the ref", o.lines.join(" ").includes("pay_QwErTy123"));

console.log("\n— email —");
const hHtml = renderInvoiceEmail(BY_HAND, ITEMS);
check("hand-paid email shows a PAID label", /PAID/i.test(hHtml));
check("hand-paid email drops the UPI id", !hHtml.includes("okicici"));
check("unpaid email keeps the UPI id", renderInvoiceEmail(UNPAID, ITEMS).includes("okicici"));

console.log("\n— PDF —");
const pdfOf = (inv) => new TextDecoder("latin1")
  .decode(renderInvoicePdf(inv, ITEMS, computeTotals(inv, ITEMS)));
const hPdf = pdfOf(BY_HAND);
check("hand-paid PDF prints PAID", hPdf.includes("(PAID)"));
check("hand-paid PDF drops the UPI id", !hPdf.includes("okicici"));
check("unpaid PDF prints PAY TO", pdfOf(UNPAID).includes("(PAY TO)"));
check("online PDF prints the ref", pdfOf(ONLINE).includes("pay_QwErTy123"));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
