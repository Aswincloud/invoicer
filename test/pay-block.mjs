// What sits where "PAY TO" goes.
//
// A settled invoice must not carry payment instructions: a receipt that still
// says "UPI aswincloud@hdfcbank" invites a second payment for something already
// paid for, and the duplicate then has to be spotted and refunded.

import { paymentBlock, renderInvoiceEmail } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

const BASE = {
  number: "INV-1", currency: "₹", tax_mode: "none", tax_rate: 0,
  biz_name: "Aswin3DPrints", biz_pay: "UPI aswincloud@hdfcbank\nA/C 1234",
};
const ITEMS = [{ description: "Widget", qty: 1, rate: 500 }];

console.log("— unpaid —");
let b = paymentBlock({ ...BASE, status: "UNPAID" });
check("label is Pay To", b.label === "Pay To", b.label);
check("shows the UPI id", b.lines.includes("UPI aswincloud@hdfcbank"), JSON.stringify(b.lines));
check("keeps typed line breaks as separate lines", b.lines.length === 2, JSON.stringify(b.lines));

console.log("\n— paid via the link —");
b = paymentBlock({ ...BASE, status: "PAID", rzp_payment_id: "pay_TOOfbctC9gi2cE",
                   paid_at: Date.UTC(2026, 7, 11, 8, 29) });
check("label is Paid", b.label === "Paid", b.label);
check("names Razorpay", b.lines[0] === "Paid online via Razorpay", b.lines[0]);
check("shows the reference", b.lines[1] === "Ref pay_TOOfbctC9gi2cE", b.lines[1]);
check("shows an unambiguous date", b.lines[2] === "11 Aug 2026", b.lines[2]);
check("UPI id is GONE", !b.lines.some((l) => l.includes("aswincloud@hdfcbank")),
  JSON.stringify(b.lines));

console.log("\n— paid by hand (cash / bank transfer) —");
b = paymentBlock({ ...BASE, status: "PAID" });
check("label is Paid", b.label === "Paid", b.label);
check("no payment instructions", !b.lines.some((l) => l.includes("aswincloud@hdfcbank")),
  JSON.stringify(b.lines));
check("no invented reference", !b.lines.some((l) => l.startsWith("Ref")),
  JSON.stringify(b.lines));

console.log("\n— status is case-insensitive —");
check("lowercase 'paid' counts as paid",
  paymentBlock({ ...BASE, status: "paid" }).label === "Paid");
check("DUE is not paid", paymentBlock({ ...BASE, status: "DUE" }).label === "Pay To");

console.log("\n— it reaches the rendered documents —");
const paidInv = { ...BASE, status: "PAID", rzp_payment_id: "pay_ABC123",
                  paid_at: Date.UTC(2026, 7, 11) };
const html = renderInvoiceEmail(paidInv, ITEMS);
check("email shows the reference", html.includes("pay_ABC123"));
check("email drops the UPI id", !html.includes("aswincloud@hdfcbank"));

const unpaidHtml = renderInvoiceEmail({ ...BASE, status: "UNPAID" }, ITEMS);
check("unpaid email still shows the UPI id", unpaidHtml.includes("aswincloud@hdfcbank"));

// The PDF is bytes; the text is written into the content stream uncompressed.
const pdf = renderInvoicePdf(paidInv, ITEMS,
  { subtotal: 500, disc: 0, shipping: 0, taxable: 500, taxRows: [], gross: 500,
    round: 0, total: 500 });
const pdfText = new TextDecoder("latin1").decode(pdf);
check("PDF shows the reference", pdfText.includes("pay_ABC123"));
check("PDF drops the UPI id", !pdfText.includes("aswincloud@hdfcbank"));
check("PDF says PAID where PAY TO was", pdfText.includes("PAID"));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
