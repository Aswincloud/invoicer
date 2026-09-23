// The Udyam number prints wherever the GSTIN prints, and nowhere it should not.
import { renderInvoiceEmail } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";
import { computeTotals } from "../src/invoice-html.js";
import { sharePage } from "../src/pay.js";
let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };
const U = "UDYAM-PY-03-0000003";
const base = { number: "T-1", issue_date: "2026-09-23", currency: "₹", tax_mode: "none", status: "PAID",
               biz_name: "Aswin3DPrints", biz_phone: "+91 90000 00000", biz_email: "x@example.com", client_name: "C" };
const items = [{ description: "Thing", qty: 1, rate: 100 }];
const pdfText = (inv) => new TextDecoder("latin1").decode(renderInvoicePdf(inv, items, computeTotals(inv, items), {}));

console.log("— email letterhead —");
check("shown when set", renderInvoiceEmail({ ...base, biz_udyam: U }, items).includes("Udyam Reg. No.: " + U));
check("absent when empty", !renderInvoiceEmail(base, items).includes("Udyam"));
check("escaped", renderInvoiceEmail({ ...base, biz_udyam: "<b>x</b>" }, items).includes("&lt;b&gt;x&lt;/b&gt;"));
check("sits with the GSTIN, both shown", (() => { const h = renderInvoiceEmail({ ...base, biz_gst: "34ABCDE1234F1Z9", biz_udyam: U }, items); return h.includes("GSTIN: 34ABCDE1234F1Z9") && h.includes("Udyam Reg. No.: " + U); })());

console.log("\n— PDF letterhead —");
check("shown when set", pdfText({ ...base, biz_udyam: U }).includes("Udyam Reg. No.: " + U));
check("absent when empty", !pdfText(base).includes("Udyam"));
check("does not change the document title (not a tax id)", pdfText({ ...base, biz_udyam: U }).includes("INVOICE"));

console.log("\n— pay page trust block —");
// sharePage needs a DB; exercise the rendering through a stub env.
const stubEnv = (inv) => ({ APP_BASE_URL: "https://x.test", DB: { prepare: () => ({ bind: () => ({ first: async () => inv, all: async () => ({ results: items }) }) }) } });
const withU = { ...base, id: "i1", share_token: "a".repeat(32), owner_email: "o@example.com", biz_udyam: U, total: 100 };
const html = await (await sharePage(stubEnv(withU), "a".repeat(32))).text();
check("shows the number to the paying stranger", html.includes("Udyam Reg. No. (MSME)") && html.includes(U));
const html0 = await (await sharePage(stubEnv({ ...withU, biz_udyam: "" }), "a".repeat(32))).text();
check("absent when empty", !html0.includes("Udyam"));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
