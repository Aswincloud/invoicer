// Pay-by-UPI and the WhatsApp payment request (2026-09-29).
//
// An unpaid invoice goes out on WhatsApp with two buttons: Pay online (/i/<token>)
// and Pay by UPI (/u/<token>). The UPI page opens a Razorpay single-use QR fixed
// to the amount when the account allows it — auto-confirmed by qr_code.credited —
// and falls back to the business's own UPI ID otherwise. What is pinned here:
// the page never mints two QRs for one amount, never offers UPI for a paid or
// cancelled invoice, the webhook settles the right invoice once, and money
// arriving twice is reported rather than silently absorbed.
//
//   node test/upipay.mjs
import { upiPage, razorpayWebhook, upiTarget } from "../src/pay.js";
import { canRequestPayment, requestParams, buildPaymentRequestMessage } from "../src/wa.js";
import { upiAmountUri, upiAppLinks } from "../src/upi.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const TOKEN = "0123456789abcdef0123456789abcdef";
const OWNER = { id: "u-1", email: "aswin@example.com" };
const BIZ = { id: "b-2", user_id: "u-1", biz_name: "AswinCloud & Co", upi_vpa: "aswin@okhdfcbank", biz_email: "hi@example.com" };
const INV = (over = {}) => ({
  id: "i-1", user_id: "u-1", business_id: "b-2", number: "INV-AC-2026-0012", status: "UNPAID", currency: "₹",
  tax_mode: "none", tax_rate: 0, discount_pct: 0, shipping: 0, round_off: 0, total: 1250,
  client_name: "Raagul", client_phone: "919876543210", client_email: "raagul@example.com",
  share_token: TOKEN, ...over,
});
const ENV = {
  RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "ks", RAZORPAY_WEBHOOK_SECRET: "whsec",
  RESEND_API_KEY: "re_test", MAIL_FROM: "billing@example.com", APP_BASE_URL: "https://invoicer.aswincloud.com",
  WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t",
};

function makeDB(inv) {
  const db = { invoices: [inv], line_items: [{ invoice_id: inv.id, pos: 0, description: "Website", qty: 1, rate: inv.total }], webhook_events: [] };
  const joined = (i) => i && { ...BIZ, ...i, owner_email: OWNER.email, biz_name: BIZ.biz_name, upi_vpa: BIZ.upi_vpa };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT i.*, u.email AS owner_email")) {
      if (s.includes("WHERE i.share_token = ?")) return { first: joined(db.invoices.find((i) => i.share_token === a[0])) || null };
      if (s.includes("WHERE i.rzp_qr_id = ?")) return { first: joined(db.invoices.find((i) => i.rzp_qr_id === a[0])) || null };
      if (s.includes("WHERE i.rzp_order_id = ?")) return { first: joined(db.invoices.find((i) => i.rzp_order_id === a[0])) || null };
    }
    if (s.startsWith("SELECT description,qty,rate,pos FROM line_items")) return { results: db.line_items.filter((l) => l.invoice_id === a[0]) };
    if (s.startsWith("SELECT description FROM line_items")) return { first: db.line_items.find((l) => l.invoice_id === a[0]) || null };
    if (s.startsWith("UPDATE invoices SET rzp_qr_id=?")) {
      const i = db.invoices.find((x) => x.id === a[5]);
      Object.assign(i, { rzp_qr_id: a[0], rzp_qr_upi: a[1], rzp_qr_amount: a[2], rzp_qr_close_by: a[3] }); return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT OR IGNORE INTO webhook_events")) {
      if (db.webhook_events.some((e) => e.event_id === a[0])) return { meta: { changes: 0 } };
      db.webhook_events.push({ event_id: a[0] }); return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE webhook_events SET invoice_id=?")) return { meta: { changes: 1 } };
    if (s.startsWith("UPDATE invoices SET status='PAID'")) {
      const qrPath = s.includes("paid_via='upi_qr'");
      const i = db.invoices.find((x) => x.id === a[qrPath ? 4 : 3]);
      if (!i || (s.includes("status <> 'PAID'") && i.status === "PAID")) return { meta: { changes: 0 } };
      i.status = "PAID"; i.paid_at = a[0]; i.rzp_payment_id = i.rzp_payment_id || a[1];
      i.paid_via = qrPath ? "upi_qr" : (i.paid_via || "checkout");
      if (qrPath && a[2]) i.rzp_amount = a[2];
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE invoices SET share_token=COALESCE(share_token, ?)")) return { meta: { changes: 1 } };
    if (s.startsWith("SELECT share_token FROM invoices WHERE id=?")) return { first: { share_token: TOKEN } };
    if (s.startsWith("UPDATE invoices SET wa_message_id=?")) { const i = db.invoices.find((x) => x.id === a[3]); i.wa_message_id = a[0]; return { meta: { changes: 1 } }; }
    throw new Error("unhandled SQL in fake D1: " + s.slice(0, 110));
  };
  return { _db: db, prepare(sql) { const make = (args) => ({ bind: (...a) => make(a), async all() { return { results: run(sql, args).results || [] }; }, async first() { return run(sql, args).first ?? null; }, async run() { return run(sql, args); } }); return make([]); } };
}

// Outbound: Razorpay QR create/close, Resend, Meta.
function envWith(inv, { qrRefused = false, over = {} } = {}) {
  const calls = { create: [], close: [], mail: [], wa: [] };
  const env = { ...ENV, ...over, DB: makeDB(inv), _c: calls };
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api.razorpay.com" && u.pathname === "/v1/payments/qr_codes") {
      calls.create.push(JSON.parse(init.body));
      if (qrRefused) return new Response(JSON.stringify({ error: { description: "QR code feature is not enabled for this merchant" } }), { status: 400 });
      n++;
      const b = JSON.parse(init.body);
      // Razorpay caps a single-use QR's life; the fake clamps to two hours the way
      // the real API is reported to, and returns the clamped close_by.
      const clamped = Math.min(b.close_by, Math.floor(Date.now() / 1000) + 2 * 3600);
      return new Response(JSON.stringify({ id: `qr_${n}`, entity: "qr_code", status: "active", close_by: clamped,
        image_content: `upi://pay?ver=01&mode=15&pa=rpy.qr${n}@icici&pn=AswinCloud&tr=RZPqr${n}&am=${(b.payment_amount / 100).toFixed(2)}&cu=INR` }), { status: 200 });
    }
    const close = u.pathname.match(/^\/v1\/payments\/qr_codes\/([^/]+)\/close$/);
    if (u.hostname === "api.razorpay.com" && close) { calls.close.push(close[1]); return new Response('{"status":"closed"}', { status: 200 }); }
    if (u.hostname === "api.resend.com") { calls.mail.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }
    if (u.hostname === "graph.facebook.com") { calls.wa.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 }); }
    throw new Error("unexpected fetch to " + url);
  };
  return env;
}
const ANDROID = new Request("https://invoicer/u/x", { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile" } });
const IPHONE = new Request("https://invoicer/u/x", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } });
const page = async (env, req = ANDROID) => (await upiPage(env, TOKEN, req)).text();

section("helpers");
ok("own-UPI link carries amount and invoice number", upiAmountUri("aswin@okhdfcbank", "AswinCloud", 125000, "INV-1") === "upi://pay?pa=aswin@okhdfcbank&pn=AswinCloud&cu=INR&am=1250.00&tn=INV-1", upiAmountUri("aswin@okhdfcbank", "AswinCloud", 125000, "INV-1"));
ok("no link for a non-VPA", upiAmountUri("someone@example.com", "x", 125000, "") === "");
ok("no link below ₹1", upiAmountUri("aswin@okhdfcbank", "x", 50, "") === "");
const links = upiAppLinks("upi://pay?pa=a@b&am=1.00");
ok("app links keep the query verbatim", links?.gpay === "tez://upi/pay?pa=a@b&am=1.00" && links.phonepe === "phonepe://pay?pa=a@b&am=1.00" && links.paytm === "paytmmp://pay?pa=a@b&am=1.00", JSON.stringify(links));
ok("no app links for a non-UPI string", upiAppLinks("https://x") === null);

section("the WhatsApp payment request");
ok("unpaid ₹ invoice may be requested", canRequestPayment(INV(), 125000).ok);
ok("paid is refused", !canRequestPayment(INV({ status: "PAID" }), 125000).ok);
ok("cancelled is refused", !canRequestPayment(INV({ status: "VOID" }), 125000).ok);
ok("non-₹ is refused", !canRequestPayment(INV({ currency: "$" }), 125000).ok);
ok("below ₹1 is refused", !canRequestPayment(INV(), 99).ok);
ok("params: name, number, amount, business", JSON.stringify(requestParams({ ...INV(), biz_name: "AswinCloud" }, 125000)) === JSON.stringify(["Raagul", "INV-AC-2026-0012", "₹1,250", "AswinCloud"]), JSON.stringify(requestParams({ ...INV(), biz_name: "AswinCloud" }, 125000)));
const m = buildPaymentRequestMessage({}, { to: "919876543210", inv: { ...INV(), biz_name: "AswinCloud" }, pdfUrl: "https://x/i/t.pdf", token: TOKEN, totalPaise: 125000 });
ok("template invoice_pay_online", m.template.name === "invoice_pay_online", m.template.name);
const comps = m.template.components;
ok("header, body, ONE url button — Razorpay only, so every payment is confirmed", comps.map((c) => c.type + (c.index ? ":" + c.index : "")).join() === "header,body,button:0", comps.map((c) => c.type).join());
ok("the button carries only the share token", comps.filter((c) => c.type === "button").every((c) => c.sub_type === "url" && c.parameters[0].text === TOKEN));
ok("header is the invoice PDF", comps[0].parameters[0].document.link === "https://x/i/t.pdf" && comps[0].parameters[0].document.filename === "INV-AC-2026-0012.pdf");

section("/u/: Razorpay QR for the exact amount, minted once");
{
  const env = envWith(INV());
  const html = await page(env);
  ok("one QR created", env._c.create.length === 1, String(env._c.create.length));
  const req = env._c.create[0];
  ok("single-use, fixed to ₹1,250", req.type === "upi_qr" && req.usage === "single_use" && req.fixed_amount === true && req.payment_amount === 125000, JSON.stringify(req));
  ok("tagged with the invoice id", req.notes?.invoicer_invoice === "i-1");
  const inv = env.DB._db.invoices[0];
  ok("stored on the invoice", inv.rzp_qr_id === "qr_1" && inv.rzp_qr_amount === 125000 && /^upi:\/\/pay\?/.test(inv.rzp_qr_upi));
  ok("with Razorpay's clamped expiry, not the 14 days asked for", inv.rzp_qr_close_by <= Date.now() + 2 * 3600 * 1000 + 5000, String(inv.rzp_qr_close_by - Date.now()));
  ok("the button opens Razorpay's upi string", html.includes('href="upi://pay?ver=01&amp;mode=15&amp;pa=rpy.qr1@icici'), html.match(/href="upi[^"]+"/)?.[0]);
  ok("Android auto-opens the chooser", /<script>setTimeout\(function\(\)\{ location\.href = "upi:\/\/pay\?ver=01/.test(html));
  ok("the QR image is shown", html.includes('src="data:image/png;base64,'));
  ok("business name is escaped", html.includes("AswinCloud &amp; Co") && !html.includes("AswinCloud & Co<"));
  ok("no 'confirm manually' note in Razorpay mode", !html.includes("confirms the transfer"));
  await page(env, IPHONE);
  ok("re-opening reuses the QR", env._c.create.length === 1, String(env._c.create.length));
  const ios = await page(env, IPHONE);
  ok("iOS gets app buttons and no auto-redirect", ios.includes("tez://upi/pay?") && ios.includes("phonepe://pay?") && !ios.includes("location.href"));
  // The total changes: a new QR, and the old one is closed.
  env.DB._db.line_items[0].rate = 1500;
  await page(env);
  ok("a changed total mints a new QR", env._c.create.length === 2 && env._c.create[1].payment_amount === 150000, String(env._c.create.length));
  ok("and closes the old one", env._c.close.includes("qr_1"), JSON.stringify(env._c.close));
  // Nearly expired: replaced.
  env.DB._db.invoices[0].rzp_qr_close_by = Date.now() + 60 * 1000;
  await page(env);
  ok("a QR about to close is replaced", env._c.create.length === 3);
}

section("/u/: falls back to the business's own UPI ID when Razorpay refuses");
{
  const env = envWith(INV(), { qrRefused: true });
  const html = await page(env);
  ok("Razorpay was asked", env._c.create.length === 1);
  ok("nothing stored", !env.DB._db.invoices[0].rzp_qr_id);
  ok("the link is the own-UPI one with amount and note", html.includes('href="upi://pay?pa=aswin@okhdfcbank&amp;pn=AswinCloud%20%26%20Co&amp;cu=INR&amp;am=1250.00&amp;tn=INV-AC-2026-0012"'), html.match(/id="open" href="[^"]+"/)?.[0]);
  ok("and says it is confirmed by hand", html.includes("confirms the transfer"));
}
{
  // Razorpay creates the QR but returns no upi string: it must be closed, not
  // left payable, and the page falls back.
  const env = envWith(INV(), { over: {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api.razorpay.com" && u.pathname === "/v1/payments/qr_codes") {
      env._c.create.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "qr_blank", entity: "qr_code", status: "active", image_url: "https://rzp.io/i/x" }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const html = await page(env);
  ok("a QR with no upi string is closed straight away", env._c.close.includes("qr_blank"), JSON.stringify(env._c.close));
  ok("and not stored", !env.DB._db.invoices[0].rzp_qr_id);
  ok("the page falls back to the own UPI ID", html.includes("pa=aswin@okhdfcbank"));
  globalThis.fetch = realFetch;
}
{
  const env = envWith(INV(), { over: { UPI_QR_ENABLED: "false" } });
  await page(env);
  ok("UPI_QR_ENABLED=false never calls Razorpay", env._c.create.length === 0);
}

section("/u/: nothing to pay");
for (const [label, over, expect] of [["paid", { status: "PAID", paid_at: 1790000000000 }, /is paid/], ["cancelled", { status: "VOID" }, /cancelled/], ["not ₹", { currency: "$" }, /not available/]]) {
  const env = envWith(INV(over));
  const html = await page(env);
  ok(`${label}: says so`, expect.test(html), html.slice(html.indexOf('<div class="sheet">'), html.indexOf('<div class="sheet">') + 140));
  ok(`${label}: no QR minted, no UPI link`, env._c.create.length === 0 && !html.includes("upi://"));
}
{
  const env = envWith(INV({ id: "i-x" }));
  const r = await upiPage(env, "ffffffffffffffffffffffffffffffff", ANDROID);
  ok("an unknown token is a 404 page", r.status === 404 || (await r.text()).toLowerCase().includes("not found"));
}

// ── the webhook ──
async function webhook(env, evt, eventId = "evt_q1") {
  const raw = JSON.stringify(evt);
  const req = new Request("https://invoicer/api/webhook/razorpay", { method: "POST", body: raw,
    headers: { "x-razorpay-signature": await hmacHex(raw, ENV.RAZORPAY_WEBHOOK_SECRET), "x-razorpay-event-id": eventId } });
  const jobs = []; const res = await razorpayWebhook(req, env, { waitUntil: (p) => jobs.push(p) }); await Promise.all(jobs); return res;
}
const CREDIT = (qrId, amount = 125000, payId = "pay_q1") => ({ event: "qr_code.credited", payload: {
  qr_code: { entity: { id: qrId, payment_amount: amount } },
  payment: { entity: { id: payId, amount, status: "captured", created_at: 1790500000 } } } });

section("qr_code.credited settles the invoice once, and sends the receipt");
{
  const env = envWith(INV({ rzp_qr_id: "qr_9", rzp_qr_amount: 125000 }));
  const res = await webhook(env, CREDIT("qr_9"));
  const inv = env.DB._db.invoices[0];
  ok("200", res.status === 200);
  ok("PAID, via upi_qr, payment id recorded", inv.status === "PAID" && inv.paid_via === "upi_qr" && inv.rzp_payment_id === "pay_q1", JSON.stringify({ s: inv.status, v: inv.paid_via, p: inv.rzp_payment_id }));
  ok("customer + owner emailed", env._c.mail.length === 2, String(env._c.mail.length));
  ok("the owner's mail states ₹1,250", env._c.mail.some((mm) => /1250\.00/.test(mm.text || "")));
  ok("the WhatsApp confirmation went out", env._c.wa.length === 1);
  await webhook(env, CREDIT("qr_9"), "evt_q1");
  ok("a redelivery changes nothing", env._c.mail.length === 2 && env._c.wa.length === 1);
  await webhook(env, CREDIT("qr_9"), "evt_q2");
  ok("a second event id on a paid invoice does not re-send the receipt", env._c.wa.length === 1);
  ok("and the same payment is not mistaken for a second one", env._c.mail.length === 2 && !env._c.mail.some((x) => /Paid twice/.test(x.subject)), JSON.stringify(env._c.mail.map((x) => x.subject)));
}
{
  const env = envWith(INV({ status: "PAID", rzp_payment_id: "pay_card", rzp_qr_id: "qr_9", rzp_qr_amount: 125000 }));
  await webhook(env, CREDIT("qr_9", 125000, "pay_upi"));
  const inv = env.DB._db.invoices[0];
  ok("paid twice: the invoice is left as it was", inv.rzp_payment_id === "pay_card" && inv.paid_via !== "upi_qr");
  ok("and the owner is told to refund one", env._c.mail.length === 1 && /Paid twice/.test(env._c.mail[0].subject) && /pay_upi/.test(env._c.mail[0].text), JSON.stringify(env._c.mail.map((x) => x.subject)));
  ok("the customer is not messaged again", env._c.wa.length === 0);
}
{
  const env = envWith(INV({ rzp_qr_id: "qr_9", rzp_qr_amount: 125000 }));
  await webhook(env, CREDIT("qr_9", 50000));
  ok("an unexpected amount is not applied", env.DB._db.invoices[0].status === "UNPAID" && env._c.mail.length === 0);
}
{
  const env = envWith(INV());
  const res = await webhook(env, CREDIT("qr_someone_else"));
  ok("a QR that is not ours is answered 200 and ignored", res.status === 200 && env.DB._db.invoices[0].status === "UNPAID" && env._c.mail.length === 0);
}

section("a cancelled invoice paid by UPI stays cancelled");
{
  const env = envWith(INV({ status: "VOID", rzp_qr_id: "qr_9", rzp_qr_amount: 125000 }));
  await webhook(env, CREDIT("qr_9"));
  ok("not revived as paid", env.DB._db.invoices[0].status === "VOID");
  ok("no confirmation to the customer", env._c.wa.length === 0 && !env._c.mail.some((x) => JSON.stringify(x.to).includes("raagul@")));
  ok("the owner is told to refund it", env._c.mail.length === 1 && /cancelled invoice/i.test(env._c.mail[0].subject), JSON.stringify(env._c.mail.map((x) => x.subject)));
}

section("card after UPI is reported, not swallowed");
{
  const env = envWith(INV({ status: "PAID", paid_via: "upi_qr", rzp_payment_id: "pay_upi", rzp_order_id: "order_2" }));
  await webhook(env, { event: "order.paid", payload: { order: { entity: { id: "order_2", amount: 125000, notes: {} } }, payment: { entity: { id: "pay_card2", amount: 125000, order_id: "order_2", created_at: 1790500000 } } } }, "evt_o2");
  ok("the invoice is left as it was", env.DB._db.invoices[0].rzp_payment_id === "pay_upi" && env.DB._db.invoices[0].paid_via === "upi_qr");
  ok("the owner is emailed about the second payment", env._c.mail.length === 1 && /Paid twice/.test(env._c.mail[0].subject) && /pay_card2/.test(env._c.mail[0].text), JSON.stringify(env._c.mail.map((x) => x.subject)));
  await webhook(env, { event: "order.paid", payload: { order: { entity: { id: "order_2", amount: 125000, notes: {} } }, payment: { entity: { id: "pay_upi", amount: 125000, order_id: "order_2" } } } }, "evt_o3");
  ok("the same payment id reported again stays silent", env._c.mail.length === 1);
}

section("paid by card: the invoice's UPI QR is closed");
{
  const env = envWith(INV({ rzp_order_id: "order_1", rzp_qr_id: "qr_7" }));
  await webhook(env, { event: "order.paid", payload: { order: { entity: { id: "order_1", amount: 125000, notes: {} } }, payment: { entity: { id: "pay_c", amount: 125000, order_id: "order_1", created_at: 1790500000 } } } }, "evt_o1");
  ok("PAID via checkout", env.DB._db.invoices[0].status === "PAID" && env.DB._db.invoices[0].paid_via === "checkout");
  ok("QR closed", env._c.close.includes("qr_7"), JSON.stringify(env._c.close));
}

console.log(`\n  upipay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
