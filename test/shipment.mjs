// The shipment follow-ups are sent as Meta TEMPLATES, and a template is a fixed
// sentence with numbered holes. Put the params in the wrong order and the
// customer reads "your order Delhivery from INV-3201 has shipped via Aswin" —
// and it goes out anyway, because Meta only checks the count. So the param
// order is pinned here against the template text, and the preview is pinned to
// use the very same params, so what Aswin confirms is what is sent.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CARRIERS, carrierName, isCarrier, normalizeAwb, trackUrl,
  shippedParams, deliveredParams, buildShippedMessage, buildDeliveredMessage,
  previewText, isDelivered, deliveredAtFrom,
} from "../src/shipment.js";
import { toE164 } from "../src/wa.js";

const env = { SHIPTRACK_BASE_URL: "https://shiptrack.aswincloud.com" };
const inv = { number: "INV-AC-2026-3201", client_name: "Priya", biz_name: "Aswin3DPrints", client_phone: "916380157944" };

test("carriers: the ShipTrack ids, with display names for the message", () => {
  assert.deepEqual(CARRIERS.map((c) => c.id), ["bluedart", "delhivery", "shiprocket", "stcourier", "tpc"]);
  assert.equal(carrierName("stcourier"), "ST Courier");
  assert.equal(carrierName("STCOURIER"), "ST Courier", "case-insensitive");
  assert.equal(carrierName("dtdc"), "", "unknown carrier has no name");
  assert.equal(isCarrier("tpc"), true);
  assert.equal(isCarrier("India Post"), false, "free text is not a carrier");
});

test("normalizeAwb: tidies what a person types, refuses garbage", () => {
  assert.equal(normalizeAwb(" ek 1234 5678 9in "), "EK123456789IN");
  assert.equal(normalizeAwb("1234-5678"), "1234-5678");
  assert.equal(normalizeAwb("ab"), "", "too short");
  assert.equal(normalizeAwb("has spaces inside?!"), "", "punctuation refused");
  assert.equal(normalizeAwb(null), "");
});

test("trackUrl: the customer's link into ShipTrack, encoded", () => {
  assert.equal(trackUrl(env, "stcourier", "ST 123"), "https://shiptrack.aswincloud.com/track/stcourier/ST%20123");
  assert.equal(trackUrl(env, "", "X"), "", "no carrier, no link");
});

test("shipped params: name, number, business, COURIER NAME, tracking — the template's order", () => {
  assert.deepEqual(shippedParams(inv, "delhivery", "1234567890123"),
    ["Priya", "INV-AC-2026-3201", "Aswin3DPrints", "Delhivery", "1234567890123"]);
  const m = buildShippedMessage(env, { to: "916380157944", inv, courier: "delhivery", awb: "1234567890123" });
  assert.equal(m.template.name, "order_shipped");
  assert.equal(m.template.language.code, "en");
  assert.equal(m.to, "916380157944");
  assert.deepEqual(m.template.components[0].parameters.map((p) => p.text),
    ["Priya", "INV-AC-2026-3201", "Aswin3DPrints", "Delhivery", "1234567890123"]);
});

test("delivered params: name, number, business", () => {
  assert.deepEqual(deliveredParams(inv), ["Priya", "INV-AC-2026-3201", "Aswin3DPrints"]);
  const m = buildDeliveredMessage(env, { to: "916380157944", inv });
  assert.equal(m.template.name, "order_delivered");
  assert.equal(m.template.components.length, 1, "body only — the template has no document header");
});

test("template names can be overridden from env, defaults match the WABA", () => {
  const m = buildShippedMessage({ WA_TEMPLATE_SHIPPED: "order_shipped_v2", WA_TEMPLATE_LANG: "en_IN" },
                                { to: "1", inv, courier: "tpc", awb: "A1B2" });
  assert.equal(m.template.name, "order_shipped_v2");
  assert.equal(m.template.language.code, "en_IN");
});

test("blank customer name and business fall back rather than sending 'Hi ,'", () => {
  assert.deepEqual(deliveredParams({ number: "X" }), ["there", "X", "us"]);
});

test("previewText: the template sentence with the same params the send uses", () => {
  const p = shippedParams(inv, "stcourier", "ST99");
  const text = previewText("shipped", p);
  assert.match(text, /^Order Shipped\n\n/);
  assert.match(text, /Hi Priya, good news — your order INV-AC-2026-3201 from Aswin3DPrints has shipped via ST Courier\. Tracking ID: ST99\./);
  assert.match(text, /\n\nReply here if you have any questions\.$/);
  assert.equal(previewText("delivered", deliveredParams(inv)).includes("{{"), false, "every hole filled");
  assert.equal(previewText("nonsense", []), "");
});

test("isDelivered / deliveredAtFrom: only a successful 'delivered' counts, dated by the courier", () => {
  assert.equal(isDelivered({ ok: true, status: "delivered" }), true);
  assert.equal(isDelivered({ ok: true, status: "out_for_delivery" }), false);
  assert.equal(isDelivered({ ok: false, error: "not_found" }), false);
  assert.equal(isDelivered(null), false);
  const t = deliveredAtFrom({ ok: true, status: "delivered", lastEvent: { timestamp: "2026-09-18T10:00:00Z" } });
  assert.equal(t, Date.parse("2026-09-18T10:00:00Z"));
  const nowish = deliveredAtFrom({ ok: true, status: "delivered", lastEvent: { timestamp: "garbage" } });
  assert.ok(Math.abs(nowish - Date.now()) < 5000, "unparseable courier time falls back to now");
});

test("bot lookup keys on the same phone shape the invoice stores", () => {
  // The invoice stores toE164(clPhone). Chatwoot hands the bot "+916380157944".
  assert.equal(toE164("+916380157944"), "916380157944");
  assert.equal(toE164("916380157944"), "916380157944");
  assert.equal(toE164("06380157944"), "916380157944");
  assert.equal(toE164("6380157944"), "916380157944");
  assert.equal(toE164("12345"), "", "ambiguous numbers match nobody");
});
