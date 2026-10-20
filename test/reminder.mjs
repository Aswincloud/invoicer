// The "payment pending" WhatsApp the shop asks for (POST /api/ingest/payment-reminder).
//   node test/reminder.mjs
import { ingestPaymentReminder } from "../src/ingest.js";
import { buildPendingPaymentMessage } from "../src/wa.js";
import { hmacHex } from "../src/lib.js";

let failed = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`); if (!cond) failed++; };
const SECRET = "s3cret", TOKEN = "0123456789abcdef0123456789abcdef";
const ENV = { SHOP_INGEST_ENABLED: "true", SHOP_INGEST_SECRET: SECRET, WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" };
let sent = [];
globalThis.fetch = async (url, init) => { if (new URL(String(url)).hostname === "graph.facebook.com") { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] })); } throw new Error("unexpected " + url); };
const call = async (body, { secret = SECRET, env = ENV } = {}) => {
  const raw = JSON.stringify(body);
  const r = await ingestPaymentReminder(new Request("https://inv/api/ingest/payment-reminder", { method: "POST", body: raw, headers: { "x-shop-signature": await hmacHex(raw, secret) } }), env);
  return [r.status, await r.json()];
};
const B = (o = {}) => ({ ts: Date.now(), receipt: "AP-534abe47", name: "PSN sankar", phone: "9876543210", amount_paise: 79800, pay_token: TOKEN, ...o });

const m = buildPendingPaymentMessage({}, { to: "919876543210", name: "Sankar", receipt: "AP-534abe47", amountPaise: 79800, payToken: TOKEN });
check("template order_payment_pending", m.template.name === "order_payment_pending");
check("body: name, receipt, amount, shop", JSON.stringify(m.template.components[0].parameters.map((p) => p.text)) === JSON.stringify(["Sankar", "AP-534abe47", "₹798", "AswinPrints"]), JSON.stringify(m.template.components[0].parameters.map((p) => p.text)));
check("one URL button carrying only the pay token", m.template.components[1].type === "button" && m.template.components[1].sub_type === "url" && m.template.components[1].parameters[0].text === TOKEN);

let [st, b] = await call(B());
check("signed request sends the WhatsApp", st === 200 && b.whatsapp === "sent" && sent.length === 1 && sent[0].to === "919876543210", JSON.stringify(b));
sent = [];
check("wrong secret 401", (await call(B(), { secret: "nope" }))[0] === 401 && sent.length === 0);
check("stale ts 401", (await call(B({ ts: Date.now() - 10 * 60 * 1000 })))[0] === 401);
check("bad receipt 400", (await call(B({ receipt: "x" })))[0] === 400);
check("bad pay token 400", (await call(B({ pay_token: "../../etc" })))[0] === 400);
check("bad amount 400", (await call(B({ amount_paise: 50 })))[0] === 400);
[st, b] = await call(B({ phone: "123" }));
check("unusable phone: skipped, nothing sent", st === 200 && b.whatsapp === "skipped" && sent.length === 0);
[st, b] = await call(B(), { env: { ...ENV, WA_ACCESS_TOKEN: "" } });
check("WhatsApp not configured: skipped", b.whatsapp === "skipped" && sent.length === 0);
check("ingest disabled: 503", (await call(B(), { env: { ...ENV, SHOP_INGEST_ENABLED: "false" } }))[0] === 503);
console.log(failed ? `\n${failed} FAILED` : "\nall pass"); process.exit(failed ? 1 : 0);
