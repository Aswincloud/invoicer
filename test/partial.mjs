// Part-payment collected by hand (migration 0024).
//
// The owner records what has come in; the invoice prints Received and Balance
// due, and anything that asks for money with a fixed amount — the share page's
// Pay button, its UPI QR, the Pay-by-UPI page, the WhatsApp payment request —
// asks for the balance. The pinned property is that a recorded part-payment can
// never be charged a second time.
import { readFileSync } from "node:fs";
import { balanceOf, renderInvoiceEmail, computeTotals } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";
import { createPayOrder, shareQr, sharePage } from "../src/pay.js";

let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

console.log("— the rule —");
check("nothing received: balance is the total", JSON.stringify(balanceOf({ status: "UNPAID" }, 1500)) === JSON.stringify({ received: 0, balance: 1500 }));
check("part received", JSON.stringify(balanceOf({ status: "UNPAID", amount_received: 500 }, 1500)) === JSON.stringify({ received: 500, balance: 1000 }));
check("paise kept exact", balanceOf({ status: "DUE", amount_received: 333.33 }, 1000).balance === 666.67);
check("more than the total is clamped, never negative", balanceOf({ status: "UNPAID", amount_received: 9999 }, 1500).balance === 0);
check("negative is ignored", balanceOf({ status: "UNPAID", amount_received: -50 }, 1500).received === 0);
check("PAID carries no balance lines", balanceOf({ status: "PAID", amount_received: 500 }, 1500).received === 0);
check("VOID carries none either", balanceOf({ status: "VOID", amount_received: 500 }, 1500).received === 0);

// The browser's copy must agree.
const money = readFileSync(new URL("../public/js/money.js", import.meta.url), "utf8");
const fnSrc = money.match(/function balanceOf\(total\)\{[\s\S]*?\n\}/)[0];
for (const [st, rec, tot] of [["UNPAID", "500", 1500], ["DUE", "333.33", 1000], ["UNPAID", "9999", 1500], ["PAID", "500", 1500], ["VOID", "500", 1500], ["UNPAID", "", 1500], ["UNPAID", "-5", 1500]]) {
  const els = { status: { value: st }, amountReceived: { value: rec } };
  const fld = (id) => (els[id]?.value || "").trim();
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const $ = (id) => els[id];
  const cli = new Function("fld", "num", "$", fnSrc + "; return balanceOf;")(fld, num, $)(tot);
  const srv = balanceOf({ status: st, amount_received: rec }, tot);
  check(`client agrees: ${st} ${rec || "blank"} of ${tot}`, JSON.stringify(cli) === JSON.stringify(srv), `${JSON.stringify(cli)} vs ${JSON.stringify(srv)}`);
}

console.log("\n— what is printed —");
const INV = { number: "INV-AC-2026-1111", status: "UNPAID", currency: "₹", tax_mode: "none", tax_rate: 0, discount_pct: 0,
  shipping: 0, round_off: 0, biz_name: "Aswin3DPrints", client_name: "Raagul", amount_received: 500 };
const ITEMS = [{ description: "Figurine", qty: 1, rate: 1500 }];
let html = renderInvoiceEmail(INV, ITEMS);
check("email/share page: Received and Balance due under the total", html.includes("Received") && html.includes("Balance due") && /1,000\.00/.test(html), "");
check("…the total itself is unchanged", /1,500\.00/.test(html));
html = renderInvoiceEmail({ ...INV, amount_received: 0 }, ITEMS);
check("no part-payment: no balance lines", !html.includes("Balance due"));
html = renderInvoiceEmail({ ...INV, status: "PAID" }, ITEMS);
check("paid: no balance lines", !html.includes("Balance due"));
const pdf = renderInvoicePdf(INV, ITEMS, computeTotals(INV, ITEMS));
const txt = new TextDecoder("latin1").decode(pdf);
check("PDF carries BALANCE DUE", txt.includes("BALANCE DUE") && txt.includes("Received"));

console.log("\n— what is charged —");
const TOKEN = "0123456789abcdef0123456789abcdef";
function env(inv, calls) {
  const row = { id: "i-1", user_id: "u-1", share_token: TOKEN, ...INV, ...inv };
  const DB = { prepare(sql) { const s = sql.replace(/\s+/g, " "); const make = (a) => ({ bind: (...x) => make(x),
    async first() { if (s.includes("WHERE i.share_token = ?")) return a[0] === TOKEN ? { ...row, owner_email: "o@x" } : null; return null; },
    async all() { return { results: s.includes("FROM line_items") ? ITEMS.map((i, k) => ({ ...i, pos: k })) : [] }; },
    async run() { if (s.startsWith("UPDATE invoices SET rzp_order_id")) { row.rzp_order_id = a[0]; row.rzp_amount = a[1]; } return { meta: { changes: 1 } }; } }); return make([]); } };
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); const b = init?.body ? JSON.parse(init.body) : {};
    if (u.pathname === "/v1/orders") { calls.push(["order", b.amount]); return new Response(JSON.stringify({ id: "order_" + calls.length, amount: b.amount }), { status: 200 }); }
    if (u.pathname === "/v1/payments/qr_codes") { calls.push(["qr", b.payment_amount]); return new Response(JSON.stringify({ id: "qr_1", image_url: "https://rzp.io/q", close_by: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 }); }
    throw new Error("unexpected " + url);
  };
  return { DB, PAY_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "k", APP_BASE_URL: "https://invoicer.aswincloud.com" };
}
let calls = [];
let e = env({}, calls);
let r = await createPayOrder(e, TOKEN); let j = await r.json();
check("Pay button orders the balance, ₹1000, not the ₹1500 total", r.status === 200 && calls[0][1] === 100000 && j.amount === 100000, JSON.stringify(calls));
calls.length = 0; r = await shareQr(e, TOKEN);
check("UPI QR is for the balance", r.status === 200 && calls[0][0] === "qr" && calls[0][1] === 100000, JSON.stringify(calls));
html = await (await sharePage(e, TOKEN)).text();
check("share page button says Pay ₹ 1,000.00", /Pay ₹ 1,000\.00/.test(html), (html.match(/Pay ₹[^<]*/) || [""])[0]);
calls.length = 0; e = env({ amount_received: 1500 }, calls);
r = await createPayOrder(e, TOKEN);
check("fully received but still marked unpaid: nothing to charge", r.status === 409 && calls.length === 0, String(r.status));

console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
