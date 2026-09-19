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

console.log("\n— only PAID may be sent: the template thanks them for paying —");
import { canSendWhatsApp } from "../src/wa.js";
check("PAID is sendable", canSendWhatsApp({ status: "PAID" }).ok);
check("paid, any case", canSendWhatsApp({ status: "paid" }).ok);
check("UNPAID is refused, and says why", !canSendWhatsApp({ status: "UNPAID" }).ok
  && /paid/i.test(canSendWhatsApp({ status: "UNPAID" }).why));
check("DUE is refused", !canSendWhatsApp({ status: "DUE" }).ok);
check("VOID is refused with its own reason", !canSendWhatsApp({ status: "VOID" }).ok
  && /cancelled/i.test(canSendWhatsApp({ status: "VOID" }).why));
check("missing status is refused", !canSendWhatsApp({}).ok && !canSendWhatsApp(null).ok);

console.log("\n— the template: one, paid, no button —");
const ENV = { WA_PHONE_NUMBER_ID: "1", WA_ACCESS_TOKEN: "t" };
const INV = { number: "INV-AC-2026-3201", status: "PAID", currency: "₹", total: 350,
              client_name: "Devadharshan", biz_name: "Aswin3DPrints" };
const ARGS = { to: "919876543210", inv: INV, pdfUrl: "https://x.test/i/abc.pdf" };
const u = buildTemplateMessage(ENV, ARGS);
check("messaging_product", u.messaging_product === "whatsapp");
check("to is the E.164 digits", u.to === "919876543210");
check("type template", u.type === "template");
check("template name order_confirmed", u.template.name === "order_confirmed", u.template.name);
check("language en", u.template.language.code === "en");
const header = u.template.components.find((c) => c.type === "header");
check("document header with the PDF link", header && header.parameters[0].document.link === ARGS.pdfUrl);
check("document filename is the invoice number", header.parameters[0].document.filename === "INV-AC-2026-3201.pdf",
  header.parameters[0].document.filename);
const body = u.template.components.find((c) => c.type === "body").parameters.map((p) => p.text);
check("body params in order: name, number, amount, business",
  JSON.stringify(body) === JSON.stringify(["Devadharshan", "INV-AC-2026-3201", "₹350.00", "Aswin3DPrints"]),
  JSON.stringify(body));
check("exactly two components: header and body", u.template.components.length === 2);
check("NO button anywhere - a receipt must not invite a second payment",
  !u.template.components.some((c) => c.type === "button"));
check("no leftover pay-token field", JSON.stringify(u).indexOf("payToken") === -1);

console.log("\n— template name and language come from the environment —");
const custom = buildTemplateMessage({ ...ENV, WA_TEMPLATE_CONFIRMED: "my_receipt", WA_TEMPLATE_LANG: "en_GB" }, ARGS);
check("custom name", custom.template.name === "my_receipt");
check("custom language", custom.template.language.code === "en_GB");

console.log("\n— degenerate rows do not produce empty params (Meta rejects them) —");
const bare = buildTemplateMessage(ENV, { ...ARGS, inv: { number: "X", status: "PAID", total: 0 } });
const bp = bare.template.components.find((c) => c.type === "body").parameters.map((p) => p.text);
check("no client name -> 'there'", bp[0] === "there");
check("no business -> 'us'", bp[3] === "us");
check("zero total formats", bp[2] === "0.00", bp[2]);
check("amount uses Indian grouping", buildTemplateMessage(ENV, { ...ARGS, inv: { ...INV, total: 123456.5 } })
  .template.components[1].parameters[2].text === "₹1,23,456.50");

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
