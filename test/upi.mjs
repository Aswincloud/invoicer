// The pay QR must name the right payee, or it is worse than not existing.
//
// Everything here guards one failure: a customer scans a receipt and their money
// goes somewhere unintended. Two ways that happens — a bad address gets accepted,
// or a good address survives into a QR that decodes to something else. So the
// validator is tested against the specific wrong things somebody would actually
// paste, and the URI is round-tripped through a real QR reader rather than
// compared as a string.

import jsQR from "jsqr";
import { isVpa, upiPayUri, isPayQrPayload, payQrText, payeeFromPayload } from "../src/upi.js";
import { qrMatrix, QR_QUIET } from "../src/qr.js";
import { payQrAttachment, isPayable } from "../src/invoice-html.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

console.log("— addresses that are real —");
for (const v of ["6380157944@yescred", "aswin.z@okhdfcbank", "a-b_c@paytm",
                 "ab@ybl", "9876543210@axl"]) {
  check(`accepts ${v}`, isVpa(v) === true);
}

console.log("\n— addresses that are not, including the plausible ones —");
// Every one of these is something a person could genuinely end up putting in
// that box. Each would produce a QR pointing at nobody, or at the wrong body.
const bad = {
  "GPay - 6380157944": "the neighbouring line in the same textarea",
  "someone@example.com": "an email address — a dotted PSP is the tell",
  "billing@aswincloud.com": "the business's own email, right there in the form",
  "6380157944": "a phone number with no handle",
  "@ybl": "no handle",
  "a@": "no PSP",
  "a@@b": "two separators",
  "has space@ybl": "whitespace",
  "": "empty",
  "  ": "blank",
};
for (const [v, why] of Object.entries(bad)) {
  check(`rejects ${JSON.stringify(v)}`, isVpa(v) === false, why);
}
check("rejects null/undefined", !isVpa(null) && !isVpa(undefined));

console.log("\n— the URI —");
const URI = upiPayUri("6380157944@yescred", "Aswin3DPrints");
check("shape is upi://pay", URI.startsWith("upi://pay?"), URI);
check("carries the address", URI.includes("pa=6380157944@yescred"));
check("carries the payee", URI.includes("pn=Aswin3DPrints"));
check("declares INR", URI.includes("cu=INR"));
check("carries NO amount — this is a static QR by choice", !/[?&]am=/.test(URI));
// "ab@ybl", not "a@ybl": a single-character handle is below the 2-char floor and
// is rejected, which is correct — it was the test that was wrong here first.
check("an ampersand in the name cannot truncate the query",
  upiPayUri("ab@ybl", "Smith & Sons").includes("pn=Smith%20%26%20Sons"),
  upiPayUri("ab@ybl", "Smith & Sons"));
check("a one-character handle is below the floor", !isVpa("a@ybl"));
check("an invalid address yields no URI at all", upiPayUri("someone@example.com", "X") === "");
check("so does an empty one", upiPayUri("", "X") === "");

console.log("\n— it survives being a QR —");
// Rendered to pixels and read by the same class of algorithm a phone camera
// uses. A string comparison would not catch an encoder that mangles a colon.
function decode(text) {
  const m = qrMatrix(text);
  if (!m) return null;                 // fail the assertion, don't throw
  const n = m.length, scale = 4, side = (n + QR_QUIET * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!m[r][c]) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const px = (((r + QR_QUIET) * scale + y) * side + (c + QR_QUIET) * scale + x) * 4;
      data[px] = data[px + 1] = data[px + 2] = 0;
    }
  }
  const got = jsQR(data, side, side);
  return got && got.data;
}
check("decodes back to the EXACT uri", decode(URI) === URI, decode(URI));
const amp = upiPayUri("ab@ybl", "Smith & Sons");
check("and with an encoded name", decode(amp) === amp);

console.log("\n— an existing provider QR is reprinted, not reconstructed —");
// A real Razorpay static QR. It carries `tr` (their reference for this specific
// QR), `mc` and `mode` alongside the address. Rebuilding the URI from `pa` alone
// would drop those and produce a code the provider never issued, so the payload
// is stored and re-encoded byte for byte.
const RZP = "upi://pay?cu=INR&mc=5262&mode=19&pa=aswincloud860450.rzp@rxairtel"
          + "&tn=Payment%20To%20Aswincloud&tr=TNjWlQSmcSddNNqrv2";

check("a real Razorpay payload is accepted", isPayQrPayload(RZP));
check("it is used EXACTLY as issued", payQrText({ pay_qr: RZP }) === RZP);
check("keeps the provider's reference", payQrText({ pay_qr: RZP }).includes("tr=TNjWlQSmcSddNNqrv2"),
  "dropping tr would be a QR Razorpay never issued");
check("a pasted payload beats a typed address",
  payQrText({ pay_qr: RZP, upi_vpa: "6380157944@yescred", biz_name: "X" }) === RZP);
check("with no payload it builds from the address",
  payQrText({ pay_qr: "", upi_vpa: "6380157944@yescred", biz_name: "A" })
    === "upi://pay?pa=6380157944@yescred&pn=A&cu=INR");
check("the payee is readable for printing beside the code",
  payeeFromPayload(RZP) === "aswincloud860450.rzp@rxairtel", payeeFromPayload(RZP));
check("an EMV/Bharat payload is accepted too", isPayQrPayload("000201010211" + "x".repeat(40)));

for (const [bad, why] of Object.entries({
  "hello there": "not a payment payload",
  "upi://pay?foo=1": "a upi uri with no payee",
  "https://example.com": "a web link is not a payment",
})) {
  check(`refuses ${JSON.stringify(bad)}`, !isPayQrPayload(bad), why);
}
check("refuses an embedded newline", !isPayQrPayload("upi://pay?pa=a@b\nsecond"));
check("refuses an absurdly long payload", !isPayQrPayload("upi://pay?pa=a@b&x=" + "y".repeat(1300)));
check("the real payload round-trips through a QR", decode(RZP) === RZP);

console.log("\n— only while the bill is actually payable —");
const INV = { status: "UNPAID", biz_name: "Aswin3DPrints", upi_vpa: "6380157944@yescred" };
check("unpaid is payable", isPayable(INV));
check("PAID is not", !isPayable({ ...INV, status: "PAID" }));
check("VOID is not — a cancelled bill must not invite a first payment",
  !isPayable({ ...INV, status: "VOID" }));
check("case does not matter", !isPayable({ ...INV, status: "paid" }));

check("unpaid + valid vpa produces an attachment", Boolean(payQrAttachment(INV)));
check("a pasted provider payload produces one too",
  Boolean(payQrAttachment({ status: "UNPAID", pay_qr: RZP })));
check("even with no upi_vpa set at all",
  Boolean(payQrAttachment({ status: "UNPAID", upi_vpa: "", pay_qr: RZP })));
check("PAID produces none", payQrAttachment({ ...INV, status: "PAID" }) === null);
check("VOID produces none", payQrAttachment({ ...INV, status: "VOID" }) === null);
check("no vpa produces none", payQrAttachment({ ...INV, upi_vpa: "" }) === null);
check("an INVALID vpa produces none — fails closed",
  payQrAttachment({ ...INV, upi_vpa: "GPay - 6380157944" }) === null);

const att = payQrAttachment(INV);
check("it is a PNG with its own content id",
  att.attachment.content_type === "image/png" && att.attachment.content_id === "payqr@invoicer");
check("distinct from the order QR's cid", att.src !== "cid:orderqr@invoicer");

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
