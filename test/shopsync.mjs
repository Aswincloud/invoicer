// The invoicer -> shop half of the shipment sync (src/shopsync.js).
//
// Shipping a shop invoice from this dashboard must tell the shop at once, signed
// the way the shop checks, for shop invoices only. Hand-made and pay-link
// invoices have no shop order and must never call it.
//
//   node test/shopsync.mjs
import { notifyShopShipment } from "../src/shopsync.js";
import { hmacHex } from "../src/lib.js";

let failed = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`); if (!cond) failed++; };
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true,"status":"shipped","emailed":true}', { status: 200 }); };
const ENV = { SHOP_INGEST_SECRET: "s3cret", SHOP_URL: "https://shop.test/" };
const INV = { source: "shop", source_ref: "AP-f814ee35", courier: "tpc", tracking_id: "TPC123" };

const r = await notifyShopShipment(ENV, INV, "shipped");
check("calls the shop's sync endpoint once", calls.length === 1 && calls[0].url === "https://shop.test/api/sync/shipment", calls[0]?.url);
const body = JSON.parse(calls[0].init.body);
check("body: receipt, kind, courier by NAME, tracking", body.receipt === "AP-f814ee35" && body.kind === "shipped" && body.courier === "The Professional Couriers" && body.tracking === "TPC123", JSON.stringify(body));
check("carries a fresh timestamp", Math.abs(Date.now() - body.ts) < 5000);
const expect = await hmacHex("invoicer->shop\n" + calls[0].init.body, "s3cret");
check("signed with the prefix the shop verifies", calls[0].init.headers["x-invoicer-signature"] === expect);
check("NOT signed the shop->invoicer way", calls[0].init.headers["x-invoicer-signature"] !== await hmacHex(calls[0].init.body, "s3cret"));
check("reports success", r.ok === true);

calls.length = 0;
for (const [label, inv] of [["hand-made invoice", { ...INV, source: null }], ["pay-link invoice", { ...INV, source: "paylink" }], ["shop invoice without a receipt", { ...INV, source_ref: "" }]]) {
  await notifyShopShipment(ENV, inv, "shipped");
  check(`${label}: no call`, calls.length === 0);
}
await notifyShopShipment({ ...ENV, SHOP_INGEST_SECRET: "" }, INV, "shipped");
check("no secret: no call", calls.length === 0);
await notifyShopShipment({ ...ENV, SHOP_SYNC_ENABLED: "false" }, INV, "shipped");
check("SHOP_SYNC_ENABLED=false: no call", calls.length === 0);
await notifyShopShipment({ SHOP_INGEST_SECRET: "s3cret" }, INV, "delivered");
check("defaults to the live shop URL", calls[0]?.url === "https://3d-prints.aswincloud.com/api/sync/shipment" && JSON.parse(calls[0].init.body).kind === "delivered", calls[0]?.url);

globalThis.fetch = async () => { throw new Error("network down"); };
const down = await notifyShopShipment(ENV, INV, "shipped");
check("a network failure never throws", down.ok === false && /network/.test(down.error));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
