// The courier-delay notice (order_delay_notice, 2026-10-20). Pinned: params in
// the template's order, the owner's free text cleaned to what Meta accepts, the
// preview reading as the message will, and the gate — any open order, paid or
// not, but never a cancelled or delivered one.
import { delayInput, delayParams, buildDelayMessage, previewText } from "../src/shipment.js";
let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

const INV = { number: "INV-AC-2026-1111", client_name: "Raagul", biz_name: "Aswin3DPrints", status: "PAID" };
let d = delayInput({ reason: "  courier services are closed\nfor Diwali.  ", until: " 24 Oct " });
check("free text cleaned to one line, trailing full stop dropped", d.reason === "courier services are closed for Diwali" && d.until === "24 Oct", JSON.stringify(d));
check("long text clamped", delayInput({ reason: "x".repeat(400), until: "y".repeat(90) }).reason.length === 160 && delayInput({ until: "y".repeat(90) }).until.length === 40);
check("missing fields come back empty, not 'undefined'", JSON.stringify(delayInput({})) === JSON.stringify({ reason: "", until: "" }));
check("params in template order", JSON.stringify(delayParams(INV, d)) === JSON.stringify(["Raagul", "INV-AC-2026-1111", "Aswin3DPrints", "courier services are closed for Diwali", "24 Oct"]));
const m = buildDelayMessage({}, { to: "919876543210", inv: INV, ...d });
check("template order_delay_notice, body only", m.template.name === "order_delay_notice" && m.template.components.length === 1 && m.template.components[0].parameters.length === 5);
check("no parameter carries a newline or tab", m.template.components[0].parameters.every((p) => !/[\n\t]|\s{4}/.test(p.text)));
check("template name overridable", buildDelayMessage({ WA_TEMPLATE_DELAY: "x_delay" }, { to: "1", inv: INV, ...d }).template.name === "x_delay");
const pv = previewText("delay", delayParams(INV, d));
check("preview reads as the message", pv.includes("Update on your order") && pv.includes("Your order is delayed because courier services are closed for Diwali.") && pv.includes("resume by 24 Oct"), pv.slice(0, 160));
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
