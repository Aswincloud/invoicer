// The pay-link webhook end to end, and the recovery for when it never arrives.
//
// A /pay payment creates its invoice ONLY in the order.paid webhook. On
// 2026-09-26 a real payment produced no invoice, no email and no WhatsApp; the
// event never reached the Worker as a valid delivery. Two things this file pins:
//
//   1. when the webhook DOES arrive, the invoice is raised PAID and the customer
//      gets the receipt email AND the WhatsApp confirmation with the PDF — the
//      WhatsApp step did not exist on this path before;
//   2. reconcilePayLinks() asks Razorpay for its orders and raises whatever is
//      missing, once, with the same receipts.
//
//   node test/webhook.mjs
import { razorpayWebhook, reconcilePayLinks } from "../src/pay.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const OWNER = { id: "u-1", email: "aswin@example.com" };
const BIZ = { id: "b-1", user_id: "u-1", is_default: 1, created_at: 1, biz_name: "AswinPrints", biz_email: "hi@example.com" };
const ENV = {
  INVOICE_OWNER_EMAIL: OWNER.email, RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "ks",
  RAZORPAY_WEBHOOK_SECRET: "whsec", RESEND_API_KEY: "re_test", MAIL_FROM: "billing@example.com",
  APP_BASE_URL: "https://invoicer.aswincloud.com",
  WA_PHONE_NUMBER_ID: "1234567890", WA_ACCESS_TOKEN: "EAAtest",
};

// A Razorpay order as the pay-link form creates it, and its captured payment.
const ORDER = (id, over = {}) => ({
  id, entity: "order", amount: 25000, amount_paid: 25000, currency: "INR", receipt: "PL-AB12", status: "paid",
  notes: { invoicer_paylink: "1", source: "paylink", name: "Raagul", phone: "9876543210",
           email: "raagul@example.com", what: "Murugan Vibhuti Box", address: "12 Beach Rd, Pondicherry", ref: "PL-AB12" },
  ...over,
});
const PAYMENT = (orderId, id = "pay_1") => ({ id, entity: "payment", amount: 25000, status: "captured", order_id: orderId, created_at: 1790400000 });

// ── fake D1: exactly the statements this path issues ──────────────
function makeDB({ invoices = [] } = {}) {
  const db = { users: [OWNER], businesses: [BIZ], invoices: invoices.map((i) => ({ ...i })), line_items: [], webhook_events: [] };
  const joined = (i) => i && { ...i, owner_email: db.users.find((u) => u.id === i.user_id)?.email,
                                biz_name: db.businesses.find((b) => b.id === i.business_id)?.biz_name };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("INSERT OR IGNORE INTO webhook_events")) {
      if (db.webhook_events.some((e) => e.event_id === a[0])) return { meta: { changes: 0 } };
      db.webhook_events.push({ event_id: a[0], event_type: a[1], received_at: a[2], invoice_id: null }); return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE webhook_events SET invoice_id=?")) { const e = db.webhook_events.find((x) => x.event_id === a[1]); if (e) e.invoice_id = a[0]; return { meta: { changes: e ? 1 : 0 } }; }
    if (s.startsWith("SELECT i.*, u.email AS owner_email")) {
      if (s.includes("WHERE i.rzp_order_id = ?")) return { first: joined(db.invoices.find((i) => i.rzp_order_id === a[0])) || null };
      if (s.includes("WHERE i.source_ref = ?")) return { first: joined(db.invoices.find((i) => i.source_ref === a[0])) || null };
      if (s.includes("WHERE i.id = ?")) return { first: joined(db.invoices.find((i) => i.id === a[0])) || null };
    }
    if (s.startsWith("SELECT * FROM users WHERE lower(email)=?")) return { first: db.users.find((u) => u.email.toLowerCase() === String(a[0]).toLowerCase()) || null };
    if (s.startsWith("SELECT * FROM businesses WHERE user_id=?")) return { first: db.businesses.find((b) => b.user_id === a[0]) || null };
    if (s.startsWith("SELECT number FROM invoices WHERE user_id=? AND number LIKE ?")) {
      const re = new RegExp("^" + a[1].replace(/%/g, ".*") + "$");
      const rows = db.invoices.filter((i) => i.user_id === a[0] && re.test(i.number)).sort((x, y) => y.number.localeCompare(x.number));
      return { first: rows[0] || null };
    }
    if (s.startsWith("INSERT INTO invoices (")) {
      const cols = s.slice(s.indexOf("(") + 1, s.indexOf(")")).split(",").map((c) => c.trim());
      const row = Object.fromEntries(cols.map((c, k) => [c, a[k]]));
      if (row.source_ref && db.invoices.some((i) => i.source_ref === row.source_ref)) throw new Error("UNIQUE constraint failed: invoices.source_ref");
      db.invoices.push(row); return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO line_items")) { db.line_items.push({ id: a[0], invoice_id: a[1], pos: a[2], description: a[3], qty: a[4], rate: a[5] }); return { meta: { changes: 1 } }; }
    if (s.startsWith("SELECT id FROM invoices WHERE source_ref=?")) { const i = db.invoices.find((x) => x.source_ref === a[0]); return { first: i ? { id: i.id } : null }; }
    if (s.startsWith("UPDATE invoices SET status='PAID'")) { const i = db.invoices.find((x) => x.id === a[3]); if (i) { i.status = "PAID"; i.paid_at = a[0]; } return { meta: { changes: i ? 1 : 0 } }; }
    if (s.startsWith("UPDATE invoices SET share_token=COALESCE(share_token, ?)")) { const i = db.invoices.find((x) => x.id === a[2]); if (i) i.share_token = i.share_token || a[0]; return { meta: { changes: i ? 1 : 0 } }; }
    if (s.startsWith("SELECT share_token FROM invoices WHERE id=?")) { const i = db.invoices.find((x) => x.id === a[0]); return { first: i ? { share_token: i.share_token || null } : null }; }
    if (s.startsWith("UPDATE invoices SET wa_message_id=?")) { const i = db.invoices.find((x) => x.id === a[3]); if (i) { i.wa_message_id = a[0]; i.wa_sent_at = a[1]; } return { meta: { changes: i ? 1 : 0 } }; }
    throw new Error("unhandled SQL in fake D1: " + s.slice(0, 100));
  };
  return { _db: db, prepare(sql) { const make = (args) => ({ bind: (...a) => make(a), async all() { return { results: run(sql, args).results || [] }; }, async first() { return run(sql, args).first ?? null; }, async run() { return run(sql, args); } }); return make([]); } };
}

// Outbound stubs: Resend, Meta, Razorpay's read-back.
function envWith({ invoices = [], razorpayOrders = [], razorpayPayments = {} } = {}, over = {}) {
  const sent = [], wa = [], rzp = [];
  const env = { ...ENV, ...over, DB: makeDB({ invoices }), _sent: sent, _wa: wa, _rzp: rzp };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("resend.com")) { sent.push(JSON.parse(init.body)); return new Response('{"id":"e"}', { status: 200 }); }
    if (u.includes("graph.facebook.com")) { wa.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid." + wa.length }] }), { status: 200 }); }
    if (u.includes("api.razorpay.com/v1/orders")) {
      rzp.push(u);
      const m = u.match(/\/orders\/([^/]+)\/payments$/);
      if (m) return new Response(JSON.stringify({ items: razorpayPayments[m[1]] || [] }), { status: 200 });
      return new Response(JSON.stringify({ items: razorpayOrders }), { status: 200 });
    }
    throw new Error("unexpected fetch to " + u);
  };
  return env;
}
const ctxOf = () => { const jobs = []; return { waitUntil: (p) => jobs.push(p), jobs }; };
const read = async (r) => [r.status, await r.json()];

async function webhook(env, evt, { eventId = "evt_1", secret = ENV.RAZORPAY_WEBHOOK_SECRET, signature = null } = {}) {
  const raw = JSON.stringify(evt);
  const req = new Request("https://invoicer/api/webhook/razorpay", { method: "POST", body: raw,
    headers: { "x-razorpay-signature": signature ?? (await hmacHex(raw, secret)), "x-razorpay-event-id": eventId } });
  const ctx = ctxOf();
  const res = await razorpayWebhook(req, env, ctx);
  await Promise.all(ctx.jobs);
  return res;
}
const PAID_EVENT = (order, payment) => ({ event: "order.paid", payload: { order: { entity: order }, payment: { entity: payment } } });

section("order.paid for a pay-link order raises the invoice and sends BOTH receipts");
{
  const env = envWith();
  const order = ORDER("order_A"), payment = PAYMENT("order_A");
  const [status] = await read(await webhook(env, PAID_EVENT(order, payment)));
  ok("200", status === 200, String(status));
  const inv = env.DB._db.invoices[0];
  ok("one invoice, PAID, from the pay link", env.DB._db.invoices.length === 1 && inv.status === "PAID" && inv.source === "paylink", JSON.stringify(inv));
  ok("numbered PL-<year>-0001", /^PL-\d{4}-0001$/.test(inv.number), inv.number);
  ok("amount is Razorpay's, in rupees", inv.total === 250, String(inv.total));
  ok("the mobile is stored E.164", inv.client_phone === "919876543210", inv.client_phone);
  ok("customer email + owner email", env._sent.length === 2 && env._sent.some((m) => /raagul@/.test(JSON.stringify(m.to))), JSON.stringify(env._sent.map((m) => m.to)));
  ok("ONE WhatsApp went out", env._wa.length === 1, String(env._wa.length));
  const msg = env._wa[0];
  ok("to the customer's mobile", msg?.to === "919876543210", msg?.to);
  ok("the approved template, no new one needed", msg?.template?.name === "order_confirmed_new", msg?.template?.name);
  const hdr = msg?.template?.components?.find((c) => c.type === "header");
  ok("with the receipt PDF as the DOCUMENT header", hdr?.parameters?.[0]?.type === "document" && /\/i\/[0-9a-f]{32}\.pdf$/.test(hdr.parameters[0].document.link), JSON.stringify(hdr));
  const body = msg?.template?.components?.find((c) => c.type === "body")?.parameters?.map((p) => p.text);
  ok("body: name, invoice number, business", body?.[0] === "Raagul" && body?.[1] === inv.number && body?.[2] === "AswinPrints", JSON.stringify(body));
  ok("the message id is recorded on the invoice", inv.wa_message_id === "wamid.1", String(inv.wa_message_id));
  ok("the event is tied to the invoice", env.DB._db.webhook_events[0]?.invoice_id === inv.id);
}

section("a redelivered event changes nothing and sends nothing");
{
  const env = envWith();
  const order = ORDER("order_B"), payment = PAYMENT("order_B");
  await webhook(env, PAID_EVENT(order, payment), { eventId: "evt_B" });
  const [status, body] = await read(await webhook(env, PAID_EVENT(order, payment), { eventId: "evt_B" }));
  ok("200 duplicate", status === 200 && body.duplicate === true, JSON.stringify(body));
  ok("still one invoice, one WhatsApp, two emails", env.DB._db.invoices.length === 1 && env._wa.length === 1 && env._sent.length === 2, `${env._wa.length} ${env._sent.length}`);
  // A DIFFERENT event id for the same order (payment.captured + order.paid, say).
  const [st2] = await read(await webhook(env, PAID_EVENT(order, payment), { eventId: "evt_B2" }));
  ok("a second event id for the same order is absorbed by source_ref", st2 === 200 && env.DB._db.invoices.length === 1);
  ok("and does not message the customer twice", env._wa.length === 1, String(env._wa.length));
}

section("a bad signature writes nothing");
{
  const env = envWith();
  const [status] = await read(await webhook(env, PAID_EVENT(ORDER("order_C"), PAYMENT("order_C")), { signature: "0000" }));
  ok("400", status === 400, String(status));
  ok("no invoice, no event row, no messages", env.DB._db.invoices.length === 0 && env.DB._db.webhook_events.length === 0 && env._wa.length === 0 && env._sent.length === 0);
}

section("no email given: WhatsApp still goes, only the owner is emailed");
{
  const env = envWith();
  const order = ORDER("order_D", { notes: { ...ORDER("x").notes, email: "" } });
  await webhook(env, PAID_EVENT(order, PAYMENT("order_D")));
  ok("one WhatsApp", env._wa.length === 1);
  ok("one email, to the owner", env._sent.length === 1 && JSON.stringify(env._sent[0].to).includes(OWNER.email), JSON.stringify(env._sent.map((m) => m.to)));
}

section("no WhatsApp configured: the invoice and emails are unaffected");
{
  const env = envWith({}, { WA_PHONE_NUMBER_ID: "", WA_ACCESS_TOKEN: "" });
  await webhook(env, PAID_EVENT(ORDER("order_E"), PAYMENT("order_E")));
  ok("invoice raised, two emails, no WhatsApp attempted", env.DB._db.invoices.length === 1 && env._sent.length === 2 && env._wa.length === 0);
}

section("reconcile: the missed payment is raised once, with the same receipts");
{
  const invoiced = ORDER("order_known"), missed = ORDER("order_missed", { receipt: "PL-ZZ99", notes: { ...ORDER("x").notes, ref: "PL-ZZ99", what: "Custom trophy" } });
  const notOurs = ORDER("order_shop", { notes: { source: "shop" } });
  const unpaid = ORDER("order_open", { status: "created", amount_paid: 0 });
  const env = envWith({
    invoices: [{ id: "i-1", user_id: "u-1", business_id: "b-1", number: "PL-2026-0001", status: "PAID", source: "paylink", source_ref: "order_known", rzp_order_id: "order_known", total: 250, client_phone: "919876543210", wa_message_id: "wamid.old" }],
    razorpayOrders: [invoiced, missed, notOurs, unpaid],
    razorpayPayments: { order_missed: [PAYMENT("order_missed", "pay_missed")] },
  });
  const [status, body] = await read(await reconcilePayLinks(env, OWNER));
  ok("200", status === 200, JSON.stringify(body));
  ok("two paid pay-link orders checked, one already known", body.checked === 2 && body.known === 1, JSON.stringify(body));
  ok("exactly one invoice created", body.created?.length === 1 && env.DB._db.invoices.length === 2, JSON.stringify(body.created));
  const made = env.DB._db.invoices.find((i) => i.source_ref === "order_missed");
  ok("it is the missed order, PAID, numbered next", made?.status === "PAID" && made?.number === "PL-2026-0002", JSON.stringify(made));
  ok("its line item is what the customer paid for", env.DB._db.line_items.find((l) => l.invoice_id === made?.id)?.description === "Custom trophy");
  ok("the captured payment's id is on it", made?.rzp_payment_id === "pay_missed", String(made?.rzp_payment_id));
  ok("the customer got the WhatsApp and the emails", env._wa.length === 1 && env._sent.length === 2, `${env._wa.length} ${env._sent.length}`);
  ok("and the response says so", body.created[0].whatsapp === "sent" && body.created[0].number === "PL-2026-0002", JSON.stringify(body.created[0]));
  ok("the shop's order and the unpaid one were left alone", !env.DB._db.invoices.some((i) => i.source_ref === "order_shop" || i.source_ref === "order_open"));
  // Run it again: nothing new.
  const [st2, b2] = await read(await reconcilePayLinks(env, OWNER));
  ok("a second run creates nothing", st2 === 200 && b2.created.length === 0 && b2.known === 2, JSON.stringify(b2));
  ok("and messages nobody", env._wa.length === 1 && env._sent.length === 2);
}

section("reconcile: owner only");
{
  const env = envWith({ razorpayOrders: [ORDER("order_F")], razorpayPayments: { order_F: [PAYMENT("order_F")] } });
  const [status] = await read(await reconcilePayLinks(env, { id: "u-2", email: "someone@else.com" }));
  ok("another signed-in user is refused", status === 403, String(status));
  ok("and Razorpay was not even asked", env._rzp.length === 0);
  const [st2] = await read(await reconcilePayLinks(envWith({}, { RAZORPAY_KEY_ID: "" }), OWNER));
  ok("no Razorpay keys → 503", st2 === 503, String(st2));
}

console.log(`\n  webhook: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
