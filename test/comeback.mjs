// The shop's COMEBACK offer on WhatsApp (POST /api/ingest/comeback). A MARKETING
// template, sent only for customers who opted in — the shop decides that.
//   node test/comeback.mjs
import { ingestComeback } from "../src/ingest.js";
import { buildComebackMessage } from "../src/wa.js";
import { hmacHex } from "../src/lib.js";

let failed = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`); if (!cond) failed++; };
const SECRET = "s3cret", TOKEN = "u0123456789abcdef0123456789abcdef";
const ENV = { SHOP_INGEST_ENABLED: "true", SHOP_INGEST_SECRET: SECRET, WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" };
let sent = [];
globalThis.fetch = async (url, init) => { if (new URL(String(url)).hostname === "graph.facebook.com") { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] })); } throw new Error("unexpected " + url); };
const call = async (body, { secret = SECRET, env = ENV } = {}) => {
  const raw = JSON.stringify(body);
  const r = await ingestComeback(new Request("https://inv/api/ingest/comeback", { method: "POST", body: raw, headers: { "x-shop-signature": await hmacHex(raw, secret) } }), env);
  return [r.status, await r.json()];
};
const B = (o = {}) => ({ ts: Date.now(), name: "Priya", phone: "9876543210", what: "Murugan Vibhuti Box", token: TOKEN, ...o });

const m = buildComebackMessage({}, { to: "919876543210", name: "Priya", what: "Murugan Vibhuti Box", token: TOKEN });
const params = m.template.components[0].parameters.map((p) => p.text);
check("template comeback_offer", m.template.name === "comeback_offer");
check("body: name, items, shop, code", JSON.stringify(params) === JSON.stringify(["Priya", "Murugan Vibhuti Box", "AswinPrints", "COMEBACK"]), JSON.stringify(params));
check("one URL button carrying only the token", m.template.components[1].sub_type === "url" && m.template.components[1].parameters[0].text === TOKEN);
const messy = buildComebackMessage({}, { to: "1", name: "  ", what: "A\n\tB    C", token: TOKEN }).template.components[0].parameters.map((p) => p.text);
check("whitespace collapsed (Meta rejects newlines/tabs/4 spaces)", messy[1] === "A B C", JSON.stringify(messy));
check("blank name reads 'there'", messy[0] === "there");
const over = buildComebackMessage({}, { to: "1", token: TOKEN, shopName: "Aswin\nPrints", code: "COME\tBACK" }).template.components[0].parameters.map((p) => p.text);
check("shop name and code are one line too", over[2] === "Aswin Prints" && over[3] === "COME BACK", JSON.stringify(over));
check("template name overridable", buildComebackMessage({ WA_TEMPLATE_COMEBACK: "x" }, { to: "1", token: TOKEN }).template.name === "x");

let [st, b] = await call(B());
check("signed request sends the WhatsApp", st === 200 && b.whatsapp === "sent" && sent.length === 1 && sent[0].to === "919876543210", JSON.stringify(b));
sent = [];
check("wrong secret 401, nothing sent", (await call(B(), { secret: "nope" }))[0] === 401 && sent.length === 0);
check("stale ts 401", (await call(B({ ts: Date.now() - 10 * 60 * 1000 })))[0] === 401);
for (const t of ["../../x", "x0123456789abcdef0123456789abcdef", "u0123", "", "u0123456789ABCDEF0123456789abcdef"]) {
  check(`bad token ${JSON.stringify(t.slice(0, 8))} 400`, (await call(B({ token: t })))[0] === 400 && sent.length === 0);
}
check("guest-order token accepted", (await call(B({ token: "o" + TOKEN.slice(1) })))[1].whatsapp === "sent");
sent = [];
[st, b] = await call(B({ phone: "123" }));
check("unusable phone: skipped", st === 200 && b.whatsapp === "skipped" && sent.length === 0);
[st, b] = await call(B(), { env: { ...ENV, WA_ACCESS_TOKEN: "" } });
check("WhatsApp not configured: skipped", b.whatsapp === "skipped" && sent.length === 0);
check("ingest disabled: 503", (await call(B(), { env: { ...ENV, SHOP_INGEST_ENABLED: "false" } }))[0] === 503);
console.log(failed ? `\n${failed} FAILED` : "\nall pass"); process.exit(failed ? 1 : 0);
