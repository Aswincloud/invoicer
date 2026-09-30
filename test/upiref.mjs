// The UPI reference on an invoice paid directly (migration 0022).
//
// Pinned: what a person pastes from a payment app is normalised the same way
// on both sides of the wire; the paid block prints it, but never over
// Razorpay's own reference; and the one endpoint that may touch a locked,
// paid invoice touches upi_ref and nothing else.
import { readFileSync } from "node:fs";
import { cleanUpiRef, setUpiRef } from "../src/upiref.js";
import { paymentBlock } from "../src/invoice-html.js";

let failed = 0;
const check = (l, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l}${d ? "   " + d : ""}`); if (!c) failed++; };

console.log("— normalising what is pasted —");
check("12-digit UTR kept", cleanUpiRef("427318905512").ref === "427318905512");
check("spaces and dashes dropped", cleanUpiRef(" 4273 1890-5512 ").ref === "427318905512");
check("letters uppercased", cleanUpiRef("axl1234abcd").ref === "AXL1234ABCD");
check("empty means none", cleanUpiRef("").ok && cleanUpiRef("").ref === "" && cleanUpiRef(null).ref === "");
check("too short refused", !cleanUpiRef("12345").ok);
check("too long refused", !cleanUpiRef("1".repeat(36)).ok);
check("punctuation refused", !cleanUpiRef("4273#18905512").ok && !cleanUpiRef("<b>123456</b>").ok);

// The browser's copy must agree with the server's on every case above.
const core = readFileSync(new URL("../public/js/core.js", import.meta.url), "utf8");
const src = core.match(/function cleanUpiRef\(raw\)\{[\s\S]*?\n\}/)[0];
const clientClean = new Function(src + "; return cleanUpiRef;")();
for (const s of ["427318905512", " 4273 1890-5512 ", "axl1234abcd", "", "12345", "1".repeat(36), "4273#18905512"]) {
  const srv = cleanUpiRef(s); const cli = clientClean(s);
  check(`client agrees on ${JSON.stringify(s).slice(0, 20)}`, srv.ok ? cli === srv.ref : cli === null, `${JSON.stringify(cli)} vs ${JSON.stringify(srv)}`);
}

console.log("\n— the paid block —");
const BASE = { number: "INV-AC-2026-1609", status: "PAID", biz_pay: "UPI aswincloud@hdfcbank" };
let b = paymentBlock({ ...BASE, upi_ref: "427318905512" });
check("says Paid by UPI with the UTR", b.label === "Paid" && b.lines[0] === "Paid by UPI" && b.lines[1] === "UTR 427318905512", JSON.stringify(b.lines));
check("and no pay-to instructions", !b.lines.some((l) => l.includes("hdfcbank")));
b = paymentBlock({ ...BASE, upi_ref: "427318905512", rzp_payment_id: "pay_ABC" });
check("Razorpay's reference wins over a typed one", b.lines[0] === "Paid online via Razorpay" && !b.lines.some((l) => l.startsWith("UTR")), JSON.stringify(b.lines));
b = paymentBlock({ ...BASE, status: "UNPAID", upi_ref: "427318905512" });
check("an unpaid invoice ignores a stray ref", b.label === "Pay To", JSON.stringify(b));

console.log("\n— POST /api/invoices/:id/upi-ref —");
function envWith(row) {
  const writes = [];
  const DB = { prepare(sql) { const make = (a) => ({ bind: (...x) => make(x),
    async first() { return sql.startsWith("SELECT") && row && a[0] === row.id && a[1] === row.user_id ? { ...row } : null; },
    async run() { writes.push({ sql: sql.replace(/\s+/g, " "), a }); if (row) { row.upi_ref = a[0]; } return { meta: { changes: 1 } }; } }); return make([]); } };
  return { DB, writes };
}
const USER = { id: "u-1" };
const call = async (env, id, body) => { const r = await setUpiRef(env, USER, id, body); return [r.status, await r.json()]; };
let env = envWith({ id: "i-1", user_id: "u-1", status: "PAID", rzp_payment_id: null });
let [st, j] = await call(env, "i-1", { upiRef: "4273 1890 5512" });
check("paid by hand: saved, normalised", st === 200 && j.upiRef === "427318905512", `${st} ${JSON.stringify(j)}`);
check("the write touches upi_ref and paid_via only", env.writes.length === 1 && /^UPDATE invoices SET upi_ref=\?, paid_via=/.test(env.writes[0].sql) && !/total|status|number|notes/.test(env.writes[0].sql.split("WHERE")[0].replace("paid_via", "")), env.writes[0]?.sql);
[st] = await call(env, "i-1", { upiRef: "" });
check("an empty ref clears it", st === 200 && env.writes.length === 2 && env.writes[1].a[0] === null);
[st] = await call(env, "i-1", { upiRef: "12#4" }); check("garbage refused, nothing written", st === 400 && env.writes.length === 2);
env = envWith({ id: "i-2", user_id: "u-1", status: "UNPAID", rzp_payment_id: null });
[st] = await call(env, "i-2", { upiRef: "427318905512" }); check("unpaid invoice refused", st === 409 && env.writes.length === 0);
env = envWith({ id: "i-3", user_id: "u-1", status: "PAID", rzp_payment_id: "pay_X" });
[st] = await call(env, "i-3", { upiRef: "427318905512" }); check("Razorpay-paid invoice refused", st === 409 && env.writes.length === 0);
env = envWith({ id: "i-4", user_id: "u-2", status: "PAID", rzp_payment_id: null });
[st] = await call(env, "i-4", { upiRef: "427318905512" }); check("someone else's invoice: 404", st === 404 && env.writes.length === 0);

console.log(`\n${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
