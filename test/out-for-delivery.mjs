// "Out for delivery" on WhatsApp (order_out_for_delivery, 2026-10-21).
//
// The half-hourly cron asks ShipTrack about every parcel shipped but not yet
// delivered. Pinned: the first out_for_delivery sends the message once, never
// again on later runs or a second attempt; delivered still sends delivered;
// no phone or no WhatsApp means nothing is sent; and the message carries the
// right business, courier and Track link.
import { checkDeliveries, buildOutForDeliveryMessage, outForDeliveryParams, previewText } from "../src/shipment.js";
let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

const OWNER = { id: "u-1", email: "aswin@example.com" };
function envWith(invs, statuses, over = {}) {
  const db = { invoices: invs.map((i) => ({ user_id: "u-1", business_id: "b-1", courier: "delhivery", client_phone: "919876543210",
    client_name: "Raagul", shipped_at: Date.now() - 86400000, delivered_at: null, ...i })) };
  const sent = [];
  const DB = { prepare(sql) { const s = sql.replace(/\s+/g, " ").trim(); const make = (a) => ({ bind: (...x) => make(x),
    async first() {
      if (s.startsWith("SELECT * FROM users")) return OWNER;
      if (s.startsWith("SELECT biz_name FROM businesses")) return { biz_name: "Aswin3DPrints" };
      return null; },
    async all() { return { results: s.startsWith("SELECT * FROM invoices") ? db.invoices.filter((i) => !i.delivered_at) : [] }; },
    async run() {
      const i = db.invoices.find((x) => x.id === a[a.length - 1]);
      if (s.startsWith("UPDATE invoices SET wa_ofd_message_id")) Object.assign(i, { wa_ofd_message_id: a[0], wa_ofd_at: a[1] });
      else if (s.startsWith("UPDATE invoices SET delivered_at")) Object.assign(i, { delivered_at: a[0], track_status: "delivered" });
      else if (s.startsWith("UPDATE invoices SET wa_delivered_message_id")) Object.assign(i, { wa_delivered_message_id: a[0], wa_delivered_at: a[1] });
      else if (s.startsWith("UPDATE invoices SET track_status")) Object.assign(i, { track_status: a[0] });
      return { meta: { changes: 1 } }; } }); return make([]); } };
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith("/api/track/")) {
      const awb = decodeURIComponent(u.pathname.split("/").pop());
      return new Response(JSON.stringify({ status: statuses[awb] || "in_transit", lastEvent: { timestamp: new Date().toISOString() } }), { status: 200 });
    }
    if (u.hostname === "graph.facebook.com") { const b = JSON.parse(init.body); sent.push(b); return new Response(JSON.stringify({ messages: [{ id: "wamid." + sent.length }] }), { status: 200 }); }
    throw new Error("unexpected fetch " + url);
  };
  return { env: { DB, INVOICE_OWNER_EMAIL: OWNER.email, WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t", SHIPTRACK_BASE_URL: "https://shiptrack.aswincloud.com", ...over }, db, sent };
}

console.log("— the message —");
const INV = { id: "i-1", number: "INV-AC-2026-1111", client_name: "Raagul", biz_name: "Aswin3DPrints", courier: "delhivery", tracking_id: "1234567890123" };
check("params: name, number, business, courier", JSON.stringify(outForDeliveryParams(INV)) === JSON.stringify(["Raagul", "INV-AC-2026-1111", "Aswin3DPrints", "Delhivery"]), JSON.stringify(outForDeliveryParams(INV)));
const m = buildOutForDeliveryMessage({ SHIPTRACK_BASE_URL: "https://shiptrack.aswincloud.com" }, { to: "919876543210", inv: INV });
check("template order_out_for_delivery", m.template.name === "order_out_for_delivery");
check("Track button points at this parcel", m.template.components[1].parameters[0].text === "delhivery/1234567890123", m.template.components[1].parameters[0].text);
check("unknown courier still gets a sane name", outForDeliveryParams({ ...INV, courier: "" })[3] === "the courier");
check("preview reads as the message", previewText("ofd", outForDeliveryParams(INV)).includes("is out for delivery today"));

console.log("\n— the cron —");
let t = envWith([{ id: "i-1", number: "INV-1", tracking_id: "AWB1" }, { id: "i-2", number: "INV-2", tracking_id: "AWB2" }], { AWB1: "out_for_delivery", AWB2: "in_transit" });
let r = await checkDeliveries(t.env);
check("first out_for_delivery: one message, to that customer", t.sent.length === 1 && t.sent[0].template.name === "order_out_for_delivery" && r.outForDelivery === 1, JSON.stringify(r));
check("…from the right business", t.sent[0].template.components[0].parameters[2].text === "Aswin3DPrints");
check("…recorded", !!t.db.invoices[0].wa_ofd_at && !t.db.invoices[1].wa_ofd_at);
r = await checkDeliveries(t.env);
check("still out for delivery next run: nothing more", t.sent.length === 1 && r.outForDelivery === 0);
t.db.invoices[0].track_status = "exception";
await checkDeliveries(t.env);
check("a second attempt the next day: still no repeat", t.sent.length === 1);
const statuses = { AWB1: "delivered", AWB2: "in_transit" };
t = (() => { const x = envWith([{ id: "i-1", number: "INV-1", tracking_id: "AWB1", wa_ofd_at: 1 }], statuses); return x; })();
r = await checkDeliveries(t.env);
check("delivered after out-for-delivery: the delivered message goes", t.sent.length === 1 && t.sent[0].template.name === "order_delivered_new" && r.notified === 1, JSON.stringify(r));
t = envWith([{ id: "i-3", number: "INV-3", tracking_id: "AWB3" }], { AWB3: "delivered" });
await checkDeliveries(t.env);
check("courier skipped out-for-delivery and went straight to delivered: only delivered, no late OFD", t.sent.length === 1 && t.sent[0].template.name === "order_delivered_new");
t = envWith([{ id: "i-4", number: "INV-4", tracking_id: "AWB4", client_phone: "" }], { AWB4: "out_for_delivery" });
await checkDeliveries(t.env);
check("no phone: nothing sent", t.sent.length === 0);
t = envWith([{ id: "i-5", number: "INV-5", tracking_id: "AWB5" }], { AWB5: "out_for_delivery" }, { WA_ACCESS_TOKEN: "" });
await checkDeliveries(t.env);
check("WhatsApp not configured: nothing sent", t.sent.length === 0);

console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
