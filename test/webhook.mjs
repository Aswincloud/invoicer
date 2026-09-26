// The pay-link webhook end to end, and the recovery for when it never arrives.
//
// A /pay payment creates its invoice ONLY in the order.paid webhook. On
// 2026-09-26 a real payment produced no invoice, no email and no WhatsApp; the
// event never reached the Worker as a valid delivery. Two things this file pins:
//
//   1. when the webhook DOES arrive, the invoice is raised PAID and the customer
//      gets the receipt email AND the WhatsApp confirmation with the PDF — the
//      WhatsApp step did not exist on this path before;
//   2. reconcilePayLinkOrders(), run by the half-hourly cron (sweepPayLinks),
//      asks Razorpay for its orders and raises whatever is missing, once, with
//      the same receipts.
//
//   node test/webhook.mjs
import { razorpayWebhook, reconcilePayLinkOrders, sweepPayLinks } from "../src/pay.js";
import { sendPaidConfirmation } from "../src/ingest.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const OWNER = { id: "u-1", email: "aswin@example.com" };
const BIZ = { id: "b-1", user_id: "u-1", is_default: 1, created_at: 1, biz_name: "AswinPrints", biz_email: "hi@example.com" };
const CLOUD = { id: "b-2", user_id: "u-1", is_default: 0, created_at: 2, biz_name: "AswinCloud", biz_email: "hello@aswincloud.com" };
const ENV = {
  INVOICE_OWNER_EMAIL: OWNER.email, RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "ks",
  RAZORPAY_WEBHOOK_SECRET: "whsec", RESEND_API_KEY: "re_test", MAIL_FROM: "billing@example.com",
  APP_BASE_URL: "https://invoicer.aswincloud.com",
  WA_PHONE_NUMBER_ID: "1234567890", WA_ACCESS_TOKEN: "EAAtest",
  PAYLINK_BUSINESS: "AswinCloud",
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
  const db = { users: [OWNER], businesses: [BIZ, CLOUD], invoices: invoices.map((i) => ({ ...i })), line_items: [], webhook_events: [], hideOnce: false, hideOrderOnce: false };
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
      if (s.includes("WHERE i.rzp_order_id = ?")) {
        // hideOrderOnce: the webhook's first lookup misses a row that exists —
        // reconcile inserted it between this lookup and the webhook's own insert.
        if (db.hideOrderOnce) { db.hideOrderOnce = false; return { first: null }; }
        return { first: joined(db.invoices.find((i) => i.rzp_order_id === a[0])) || null };
      }
      if (s.includes("WHERE i.source_ref = ?")) return { first: joined(db.invoices.find((i) => i.source_ref === a[0])) || null };
      if (s.includes("WHERE i.id = ?")) return { first: joined(db.invoices.find((i) => i.id === a[0])) || null };
    }
    if (s.startsWith("SELECT * FROM users WHERE lower(email)=?")) return { first: db.users.find((u) => u.email.toLowerCase() === String(a[0]).toLowerCase()) || null };
    if (s.startsWith("SELECT * FROM businesses WHERE user_id=? AND lower(biz_name)=lower(?)")) {
      return { first: db.businesses.find((b) => b.user_id === a[0] && b.biz_name.toLowerCase() === String(a[1]).toLowerCase()) || null };
    }
    if (s.startsWith("SELECT * FROM businesses WHERE user_id=?")) {
      // The default business: is_default first, as the real ORDER BY does.
      return { first: [...db.businesses].filter((b) => b.user_id === a[0]).sort((x, y) => y.is_default - x.is_default)[0] || null };
    }
    if (s.startsWith("SELECT description FROM line_items WHERE invoice_id=?")) {
      const li = db.line_items.filter((l) => l.invoice_id === a[0]).sort((x, y) => x.pos - y.pos)[0];
      return { first: li ? { description: li.description } : null };
    }
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
    if (s.startsWith("SELECT id FROM invoices WHERE source_ref=?")) {
      // hideOnce: the pre-check misses a row that exists — the race where a
      // webhook lands between reconcile's check and its insert.
      if (db.hideOnce) { db.hideOnce = false; return { first: null }; }
      const i = db.invoices.find((x) => x.source_ref === a[0]); return { first: i ? { id: i.id } : null };
    }
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
    const u = String(url); const host = new URL(u).hostname;
    if (host === "api.resend.com") { sent.push(JSON.parse(init.body)); return new Response('{"id":"e"}', { status: 200 }); }
    if (host === "graph.facebook.com") { wa.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid." + wa.length }] }), { status: 200 }); }
    if (host === "api.razorpay.com") {
      const path = new URL(u).pathname; rzp.push(u);
      const J = (o, status = 200) => new Response(JSON.stringify(o), { status });
      const miss = () => J({ error: { description: "The id provided does not exist" } }, 400);
      let m;
      if ((m = path.match(/^\/v1\/orders\/([^/]+)\/payments$/))) return J({ items: razorpayPayments[m[1]] || [] });
      if ((m = path.match(/^\/v1\/orders\/([^/]+)$/))) { const o = razorpayOrders.find((x) => x.id === m[1]); return o ? J(o) : miss(); }
      if ((m = path.match(/^\/v1\/payments\/([^/]+)$/))) { const pay = Object.values(razorpayPayments).flat().find((x) => x.id === m[1]); return pay ? J(pay) : miss(); }
      if (path === "/v1/orders") return J({ items: razorpayOrders });
    }
    throw new Error("unexpected fetch to " + u);
  };
  return env;
}
const ctxOf = () => { const jobs = []; return { waitUntil: (p) => jobs.push(p), jobs }; };
const read = async (r) => [r.status, await r.json()];
// The cron's reconcile returns a plain summary; shape it like a response so the
// sections below read the same way.
const reconcile = async (env) => { const r = await reconcilePayLinkOrders(env); return [r.ok ? 200 : 502, r]; };

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
  ok("the RECEIPT template, not the shop's order-confirmed one", msg?.template?.name === "payment_received", msg?.template?.name);
  ok("billed as the pay-link business, AswinCloud", inv.business_id === "b-2", String(inv.business_id));
  const hdr = msg?.template?.components?.find((c) => c.type === "header");
  ok("with the receipt PDF as the DOCUMENT header", hdr?.parameters?.[0]?.type === "document" && /\/i\/[0-9a-f]{32}\.pdf$/.test(hdr.parameters[0].document.link), JSON.stringify(hdr));
  const body = msg?.template?.components?.find((c) => c.type === "body")?.parameters?.map((p) => p.text);
  ok("body: name, ₹amount, what for, receipt number, business",
     JSON.stringify(body) === JSON.stringify(["Raagul", "₹250", "Murugan Vibhuti Box", inv.number, "AswinCloud"]), JSON.stringify(body));
  const owner = env._sent.find((m) => JSON.stringify(m.to).includes(OWNER.email));
  ok("the owner's mail carries the full details", owner && ["Raagul", "+91 98765 43210", "raagul@example.com", "Murugan Vibhuti Box", "12 Beach Rd, Pondicherry", "₹ 250.00", inv.number, "pay_1"].every((s) => owner.text.includes(s)), owner?.text);
  ok("and links the receipt", owner && /\/i\/[0-9a-f]{32}/.test(owner.text), owner?.text);
  ok("subject says payment received, from whom, how much", /^Payment received — ₹ 250\.00 from Raagul$/.test(owner?.subject || ""), owner?.subject);
  const client = env._sent.find((m) => JSON.stringify(m.to).includes("raagul@"));
  ok("the customer's receipt states the amount", client && client.text.includes("₹ 250.00"), client?.text);
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
  const [status, body] = await reconcile(env);
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
  ok("the receipt WhatsApp says what was paid for", env._wa[0]?.template?.components?.find((c) => c.type === "body")?.parameters?.[2]?.text === "Custom trophy");
  // Run it again: nothing new.
  const [st2, b2] = await reconcile(env);
  ok("a second run creates nothing", st2 === 200 && b2.created.length === 0 && b2.known === 2, JSON.stringify(b2));
  ok("and messages nobody", env._wa.length === 1 && env._sent.length === 2);
}

section("reconcile: Razorpay's payment lookup failing never produces a ₹0 receipt");
{
  const missed = ORDER("order_nopay", { amount_paid: 25000 });
  const env = envWith({ razorpayOrders: [missed], razorpayPayments: {} });   // no captured payment listed
  const [status, body] = await reconcile(env);
  ok("the invoice is still raised from the order's amount", status === 200 && body.created.length === 1 && env.DB._db.invoices[0]?.total === 250, JSON.stringify(body));
  const client = env._sent.find((m) => JSON.stringify(m.to).includes("raagul@"));
  ok("the customer's email says ₹250, not ₹0.00", client && client.text.includes("₹ 250.00") && !client.text.includes("₹ 0.00"), client?.text);
  ok("the WhatsApp says ₹250 too", env._wa[0]?.template?.components?.find((c) => c.type === "body")?.parameters?.[1]?.text === "₹250");
  ok("no payment id is invented", !env.DB._db.invoices[0]?.rzp_payment_id);
}

section("reconcile: a webhook winning the race means no second receipt");
{
  // Pre-check says "no invoice", but by the time reconcile inserts, the row is
  // there (the webhook landed in between). UNIQUE fires, the existing row comes
  // back created:false, and nothing is sent again.
  const env = envWith({
    invoices: [{ id: "i-race", user_id: "u-1", business_id: "b-2", number: "PL-2026-0001", status: "PAID", source: "paylink", source_ref: "order_race", rzp_order_id: "order_race", total: 250, client_phone: "919876543210", client_email: "raagul@example.com", wa_message_id: "wamid.webhook" }],
    razorpayOrders: [ORDER("order_race")], razorpayPayments: { order_race: [PAYMENT("order_race")] },
  });
  env.DB._db.hideOnce = true;
  const [status, body] = await reconcile(env);
  ok("200, nothing created, counted as known", status === 200 && body.created.length === 0 && body.known === 1, JSON.stringify(body));
  ok("no email, no WhatsApp went out", env._sent.length === 0 && env._wa.length === 0, `${env._sent.length} ${env._wa.length}`);
  ok("still one invoice", env.DB._db.invoices.length === 1);
}

section("the webhook, too, notifies only what it raised");
{
  const env = envWith();
  const order = ORDER("order_W"), payment = PAYMENT("order_W");
  await webhook(env, PAID_EVENT(order, payment), { eventId: "evt_W1" });
  const before = { wa: env._wa.length, mail: env._sent.length };
  // A second, different event id for the same order: the row exists → created:false.
  await webhook(env, PAID_EVENT(order, payment), { eventId: "evt_W2" });
  ok("second event id: no more messages", env._wa.length === before.wa && env._sent.length === before.mail);
}

section("the webhook losing the race to reconcile sends nothing");
{
  // Reconcile raised the invoice (and sent the receipts) a moment before this
  // event; the webhook's lookup by order id misses it, its insert hits UNIQUE,
  // the existing row comes back created:false — and it must stay quiet.
  const env = envWith({
    invoices: [{ id: "i-r", user_id: "u-1", business_id: "b-2", number: "PL-2026-0001", status: "PAID", source: "paylink", source_ref: "order_R", rzp_order_id: "order_R", total: 250, client_phone: "919876543210", client_email: "raagul@example.com", wa_message_id: "wamid.reconcile" }],
  });
  env.DB._db.hideOrderOnce = true;
  const [status] = await read(await webhook(env, PAID_EVENT(ORDER("order_R"), PAYMENT("order_R")), { eventId: "evt_R" }));
  ok("200", status === 200, String(status));
  ok("still one invoice", env.DB._db.invoices.length === 1);
  ok("no email, no WhatsApp", env._sent.length === 0 && env._wa.length === 0, `${env._sent.length} ${env._wa.length}`);
}

section("the dashboard path: a receipt learns what was paid for from the line item");
{
  // whatsappInvoice() in index.js does not know the order's notes; the shared
  // sender looks up the first line item for a pay-link invoice.
  const env = envWith();
  const inv = { id: "i-li", user_id: "u-1", business_id: "b-2", number: "PL-2026-0009", status: "PAID", source: "paylink", total: 250, rzp_amount: 25000, currency: "₹",
                client_name: "Raagul", client_phone: "919876543210", biz_name: "AswinCloud" };
  env.DB._db.invoices.push({ ...inv }); env.DB._db.line_items.push({ id: "l1", invoice_id: "i-li", pos: 0, description: "Website redesign", qty: 1, rate: 250 });
  const r = await sendPaidConfirmation(env, { id: "i-li", inv, label: "PL-2026-0009" });
  ok("sent", r === "sent", r);
  const body = env._wa[0]?.template?.components?.find((c) => c.type === "body")?.parameters?.map((p) => p.text);
  ok("the receipt names the line item", body?.[2] === "Website redesign", JSON.stringify(body));
  ok("a shop invoice still gets the confirmation, no lookup", (await sendPaidConfirmation(env, { id: "i-li", inv: { ...inv, source: "shop", wa_message_id: null }, label: "x" })) === "sent"
     && env._wa[1]?.template?.name === "order_confirmed_new", env._wa[1]?.template?.name);
}

section("PAYLINK_BUSINESS unset falls back to the default business");
{
  const env = envWith({}, { PAYLINK_BUSINESS: "" });
  await webhook(env, PAID_EVENT(ORDER("order_D2"), PAYMENT("order_D2")));
  ok("billed as the default business", env.DB._db.invoices[0]?.business_id === "b-1");
  ok("and the WhatsApp names it", env._wa[0]?.template?.components?.find((c) => c.type === "body")?.parameters?.[4]?.text === "AswinPrints");
}

section("cron sweep: the missed payment is raised with nobody signed in");
{
  const missed = ORDER("order_cron", { receipt: "PL-CR01", notes: { ...ORDER("x").notes, ref: "PL-CR01", what: "Nameplate" } });
  const env = envWith({ razorpayOrders: [missed, ORDER("order_shop2", { notes: { source: "shop" } })],
                        razorpayPayments: { order_cron: [PAYMENT("order_cron", "pay_cron")] } }, { PAY_ENABLED: "true" });
  const r = await sweepPayLinks(env);
  ok("one invoice raised, from the cron, with no user", r.ok && r.created?.length === 1 && env.DB._db.invoices.length === 1, JSON.stringify(r));
  ok("owner and customer emailed, customer WhatsApped", env._sent.length === 2 && env._wa.length === 1, `${env._sent.length} ${env._wa.length}`);
  const again = await sweepPayLinks(env);
  ok("the next tick finds it known and sends nothing more", again.known === 1 && again.created.length === 0 && env._sent.length === 2);
}

section("cron sweep: off when pay links or Razorpay are off, and never throws");
{
  const off = await sweepPayLinks(envWith({}, { PAY_ENABLED: "true", PAYLINK_ENABLED: "false" }));
  ok("pay links disabled: skipped, Razorpay never asked", off.skipped === true);
  const noRzp = await sweepPayLinks(envWith({}, { PAY_ENABLED: "true", RAZORPAY_KEY_ID: "" }));
  ok("Razorpay unconfigured: skipped", noRzp.skipped === true);
  const broken = envWith({}, { PAY_ENABLED: "true" });
  const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("network down"); };
  const r = await sweepPayLinks(broken); globalThis.fetch = realFetch;
  ok("a Razorpay outage is reported, not thrown", r.ok === false && /down|refused/i.test(r.error || ""), JSON.stringify(r));
}


console.log(`\n  webhook: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
