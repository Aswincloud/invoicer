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

// The cron looks the business name up by its real column. This once read
// `SELECT name FROM businesses` - no such column - and every automatic
// delivered message went out as "from us". Pin the SQL to the schema.
import { readFileSync } from "node:fs";
{
  const src = readFileSync(new URL("../src/shipment.js", import.meta.url), "utf8");
  const ddl = readFileSync(new URL("../migrations/0010_businesses.sql", import.meta.url), "utf8");
  const cols = [...ddl.matchAll(/^\s*([a-z_]+)\s+(TEXT|INTEGER|REAL)/gmi)].map((m) => m[1]);
  const selects = [...src.matchAll(/SELECT\s+([a-z_]+)\s+FROM\s+businesses/gi)].map((m) => m[1]);
  console.log("\n— the cron's business lookup uses a real column —");
  console.log(selects.length ? "PASS" : "FAIL", " it selects something from businesses", selects);
  for (const c of selects)
    console.log(cols.includes(c) ? "PASS" : "FAIL", ` businesses.${c} exists in the schema`);
  if (!selects.length || selects.some((c) => !cols.includes(c))) process.exitCode = 1;
}

// Verifying a quoted invoice from a phone that is not on it. The comparison is
// code, on what the customer typed, against what is printed on the invoice.
import { amountsIn, hintMatches } from "../src/shipment.js";
{
  const inv = { client_name: "Vennila R", total: 1299.5, biz_name: "Aswin3DPrints" };
  const cases = [
    ["full name",             hintMatches(inv, ["my name is Vennila R"]),        "name"],
    ["first name only",       hintMatches(inv, ["vennila"]),                     "name"],
    ["name inside a sentence",hintMatches(inv, ["it was billed to VENNILA"]),    "name"],
    ["exact amount",          hintMatches(inv, ["1299.50"]),                     "amount"],
    ["rounded amount",        hintMatches(inv, ["it was 1300 rupees"]),          "amount"],
    ["amount with symbol",    hintMatches(inv, ["₹1,299.5"]),                   "amount"],
    ["biller, spaced",        hintMatches(inv, ["Aswin 3D Prints"]),             "biller"],
    ["biller, lowercase",     hintMatches(inv, ["from aswin3dprints"]),          "biller"],
    ["wrong name",            hintMatches(inv, ["Priya"]),                       ""],
    ["wrong amount",          hintMatches(inv, ["500"]),                         ""],
    ["nothing typed",         hintMatches(inv, []),                              ""],
    ["two-letter name never matches", hintMatches({ client_name: "Al", total: 0, biz_name: "" }, ["al"]), ""],
    ["short biller never matches",    hintMatches({ client_name: "", total: 0, biz_name: "Ab" }, ["ab"]), ""],
    ["order date is not an amount",   hintMatches({ client_name: "", total: 2026, biz_name: "" }, ["ordered on 19/9/2026"]), "amount"],
  ];
  console.log("\n— quoted-invoice verification —");
  let bad = 0;
  for (const [name, got, want] of cases) { const ok = got === want; bad += !ok; console.log(ok ? "PASS" : "FAIL", ` ${name}`, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
  console.log(JSON.stringify(amountsIn("₹1,299.00 and 350 or 2 items")) === "[1299,350,2]" ? "PASS" : "FAIL", " amountsIn parses separators");
  if (bad) process.exitCode = 1;
}
