// Every WhatsApp message a customer is sent is copied to WA_COPY_TO (the
// owner's own number), so the owner can see how it rendered. Pinned: the copy
// is byte-identical but for the recipient, it follows only an accepted send,
// it never goes to the owner twice, and a failed copy cannot fail the send.
import { sendTemplate } from "../src/wa.js";
let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

const ENV = { WA_PHONE_NUMBER_ID: "1336188189573573", WA_ACCESS_TOKEN: "EAAtest", WA_COPY_TO: "+91 63801 57944" };
const MSG = { messaging_product: "whatsapp", to: "919876543210", type: "template",
  template: { name: "order_confirmed_new", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Priya" }] }] } };
let sent = [], plan = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); sent.push(body);
  const p = plan.shift() || "ok";
  if (p === "throw") throw new Error("socket hang up");
  if (p === "fail") return new Response(JSON.stringify({ error: { message: "Recipient not in allowed list", code: 131030 } }), { status: 400 });
  return new Response(JSON.stringify({ messages: [{ id: "wamid." + sent.length }] }), { status: 200 });
};

sent = []; plan = [];
let r = await sendTemplate(ENV, MSG);
check("customer send succeeds and returns the customer's message id", r.ok && r.id === "wamid.1", JSON.stringify(r));
check("then exactly one copy, to the owner in E.164", sent.length === 2 && sent[1].to === "916380157944", JSON.stringify(sent.map((m) => m.to)));
check("the copy is identical apart from the recipient", JSON.stringify({ ...sent[1], to: MSG.to }) === JSON.stringify(MSG));

sent = []; plan = ["fail"];
r = await sendTemplate(ENV, MSG);
check("a refused customer send is reported, and no copy goes out", !r.ok && sent.length === 1, `${JSON.stringify(r)} ${sent.length}`);

sent = []; plan = ["ok", "fail"];
r = await sendTemplate(ENV, MSG);
check("a refused copy does not fail the customer's send", r.ok && r.id === "wamid.1" && sent.length === 2, JSON.stringify(r));
sent = []; plan = ["ok", "throw"];
r = await sendTemplate(ENV, MSG);
check("nor does a network error on the copy", r.ok && sent.length === 2, JSON.stringify(r));

sent = []; plan = [];
r = await sendTemplate(ENV, { ...MSG, to: "916380157944" });
check("a message already addressed to the owner is not copied to them again", r.ok && sent.length === 1);

sent = []; plan = [];
r = await sendTemplate({ ...ENV, WA_COPY_TO: "" }, MSG);
check("no WA_COPY_TO: no copy", r.ok && sent.length === 1);
r = await sendTemplate({ ...ENV, WA_COPY_TO: "not a number" }, MSG);
check("an unusable WA_COPY_TO is ignored, not sent to", r.ok && sent.length === 2 && sent.every((m) => m.to === MSG.to));

console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
