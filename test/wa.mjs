// The WhatsApp send, minus the network.
//
// Two things here can cost real money or real embarrassment, and both are
// pure functions: the number the bill goes to, and the template the message
// uses. A misread digit sends someone's invoice to a stranger; a paid receipt
// with a "Pay online" button invites a second payment. So both are pinned
// without touching Meta.

import { toE164, prettyE164, buildTemplateMessage, waConfigured } from "../src/wa.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

console.log("— numbers: accepts the shapes people type —");
for (const [raw, want] of [
  ["9876543210",        "919876543210"],
  ["+91 98765 43210",   "919876543210"],
  ["+91-98765-43210",   "919876543210"],
  ["09876543210",       "919876543210"],
  ["919876543210",      "919876543210"],
  ["0091 98765 43210",  "919876543210"],
  ["+44 7700 900123",   "447700900123"],
  ["+1 (415) 555-0123", "14155550123"],
]) check(`${raw.padEnd(20)} -> ${want}`, toE164(raw) === want, toE164(raw));

console.log("\n— numbers: refuses what it cannot be sure of (fails closed) —");
for (const raw of ["", "   ", "12345", "5876543210", "abc", "98765 4321", "+", "1234567890123456",
                   "0441234567", "044 2345 6789"]) {
  check(`${JSON.stringify(raw).padEnd(20)} -> ""`, toE164(raw) === "", JSON.stringify(toE164(raw)));
}
check("null and undefined", toE164(null) === "" && toE164(undefined) === "");
check("pretty print", prettyE164("916380157944") === "+91 63801 57944", prettyE164("916380157944"));

console.log("\n— configured only when both secrets exist —");
check("neither", !waConfigured({}));
check("id only", !waConfigured({ WA_PHONE_NUMBER_ID: "1" }));
check("token only", !waConfigured({ WA_ACCESS_TOKEN: "t" }));
check("both", waConfigured({ WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" }));

console.log("\n— the template: unpaid gets a pay button, paid does not —");
const ENV = { WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" };
const INV = { number: "INV-AC-2026-3201", status: "UNPAID", currency: "₹", total: 350,
              client_name: "Devadharshan", biz_name: "Aswin3DPrints" };
const ARGS = { to: "919876543210", inv: INV, pdfUrl: "https://x.test/i/abc.pdf", payToken: "abc" };
const u = buildTemplateMessage(ENV, ARGS);
check("messaging_product", u.messaging_product === "whatsapp");
check("to is the E.164 digits", u.to === "919876543210");
check("type template", u.type === "template");
check("unpaid template name", u.template.name === "invoice_ready", u.template.name);
check("language en", u.template.language.code === "en");
const header = u.template.components.find((c) => c.type === "header");
check("document header with the PDF link", header && header.parameters[0].document.link === ARGS.pdfUrl);
check("document filename is the invoice number", header.parameters[0].document.filename === "INV-AC-2026-3201.pdf",
  header.parameters[0].document.filename);
const body = u.template.components.find((c) => c.type === "body").parameters.map((p) => p.text);
check("body params in order: name, number, amount, business",
  JSON.stringify(body) === JSON.stringify(["Devadharshan", "INV-AC-2026-3201", "₹350.00", "Aswin3DPrints"]),
  JSON.stringify(body));
const btn = u.template.components.find((c) => c.type === "button");
check("URL button present", btn && btn.sub_type === "url" && btn.index === "0");
check("button carries only the token (Meta wants the URL tail)", btn.parameters[0].text === "abc");

const p = buildTemplateMessage(ENV, { ...ARGS, inv: { ...INV, status: "PAID" } });
check("paid template name", p.template.name === "invoice_paid", p.template.name);
check("paid has NO button", !p.template.components.some((c) => c.type === "button"));
check("paid still has the PDF", p.template.components.some((c) => c.type === "header"));

console.log("\n— template names come from the environment —");
const custom = buildTemplateMessage({ ...ENV, WA_TEMPLATE_UNPAID: "my_inv", WA_TEMPLATE_LANG: "en_GB" }, ARGS);
check("custom unpaid name", custom.template.name === "my_inv");
check("custom language", custom.template.language.code === "en_GB");

console.log("\n— degenerate rows do not produce empty params (Meta rejects them) —");
const bare = buildTemplateMessage(ENV, { ...ARGS, inv: { number: "X", status: "UNPAID", total: 0 } });
const bp = bare.template.components.find((c) => c.type === "body").parameters.map((p) => p.text);
check("no client name -> 'there'", bp[0] === "there");
check("no business -> 'us'", bp[3] === "us");
check("zero total formats", bp[2] === "0.00", bp[2]);
check("amount uses Indian grouping", buildTemplateMessage(ENV, { ...ARGS, inv: { ...INV, total: 123456.5 } })
  .template.components[1].parameters[2].text === "₹1,23,456.50");

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
