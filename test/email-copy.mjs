// The owner's blind copy of every email a client receives. The shop sends no
// client mail of its own about invoices — these three are the invoicer's, and
// each must carry a bcc to the owner so the owner's inbox holds exactly what
// the client was told.
import { readFileSync } from "node:fs";
import { sendEmail } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const sent = [];
globalThis.fetch = async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response('{"id":"m"}'); };
const env = { RESEND_API_KEY: "k" };

await sendEmail(env, { to: "client@example.com", subject: "s", text: "t", bcc: "owner@example.com" });
ok("bcc is sent as a list", JSON.stringify(sent[0].bcc) === '["owner@example.com"]', JSON.stringify(sent[0].bcc));
await sendEmail(env, { to: "Owner@Example.com", subject: "s", text: "t", bcc: "owner@example.com" });
ok("no bcc when the owner is already the recipient (any case)", sent[1].bcc === undefined, JSON.stringify(sent[1].bcc));
await sendEmail(env, { to: "client@example.com", subject: "s", text: "t", bcc: "" });
ok("an empty bcc is dropped, the mail still goes", sent[2].bcc === undefined && sent.length === 3);
await sendEmail(env, { to: "client@example.com", subject: "s", text: "t" });
ok("no bcc unless asked", !("bcc" in sent[3]));

// The dashboard's "Email invoice" handler has no harness of its own; pin the
// one line that copies the signed-in owner.
const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("async function emailInvoice"));
const call = body.slice(body.indexOf("sendEmail(env, {"), body.indexOf("});", body.indexOf("sendEmail(env, {")));
ok("Email invoice copies the signed-in owner", /\bbcc: user\.email,/.test(call), call.slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
