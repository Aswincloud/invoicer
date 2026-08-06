// Tests for the Worker-generated PDF.
//
// Run: node test/pdf.mjs
//
// A PDF test that only checks "some bytes came out" is worthless — a corrupt
// file has bytes too. So this writes real files to /tmp and the shell wrapper
// (test/pdf-verify.sh) runs pdftotext and pypdf over them, which are independent
// parsers that will refuse a malformed document.
//
// What is asserted HERE is the structure and the arithmetic; what is asserted
// THERE is that a real reader can open it and read the numbers back.

import { renderInvoicePdf, toBase64 } from "../src/invoice-pdf.js";
import { computeTotals } from "../src/invoice-html.js";
import { writeFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const INV = (over = {}) => ({
  number: "AP-2026-PDFTEST", issue_date: "2026-08-06", due_date: "", currency: "₹",
  tax_mode: "none", tax_rate: 0, discount_pct: 0, round_off: 0,
  shipping: 99, shipping_mode: "", status: "PAID",
  notes: "Paid online on 2026-08-06. Order reference AP-pdftest.",
  client_name: "Test Buyer", client_email: "buyer@example.com",
  client_addr: "12 Test St, Chennai, TN, 600001", client_gst: "",
  biz_name: "AswinPrints", biz_email: "aswin@aswincloud.com",
  biz_addr: "No.76 Venkata Nagar, Uruvaiyar Villianur, Pondicherry - 605110",
  biz_gst: "", biz_pay: "Paid online via Razorpay", ...over,
});
const ITEMS = [
  { description: "Dragon 3D Print", qty: 1, rate: 1299 },
  { description: "Discount (promo code CHAT-ABC123)", qty: 1, rate: -300 },
];

const build = (inv, items) => renderInvoicePdf(inv, items, computeTotals(inv, items));
const asText = (bytes) => new TextDecoder("latin1").decode(bytes);

// ── structure ─────────────────────────────────────────────────────
//
// A PDF reader seeks directly to the byte offsets in the xref table. If those
// are wrong the file opens blank or not at all, and nothing in the JavaScript
// would have complained.
section("the file is a structurally valid PDF");
{
  const pdf = build(INV(), ITEMS);
  const s = asText(pdf);

  ok("starts with the PDF header", s.startsWith("%PDF-1.4"));
  ok("ends with EOF", s.trimEnd().endsWith("%%EOF"));
  ok("has a catalog", s.includes("/Type /Catalog"));
  ok("has a pages tree", s.includes("/Type /Pages"));
  ok("declares A4", s.includes("/MediaBox [0 0 595.28 841.89]"));
  ok("embeds no fonts (base-14 only)", !s.includes("/FontFile"));
  ok("uses WinAnsiEncoding", s.includes("/WinAnsiEncoding"));

  // The xref offsets must actually point at their objects. This is the check
  // that catches the classic bug: building the file as a string, so one
  // multi-byte character shifts every offset after it.
  const xrefAt = Number(/startxref\s+(\d+)/.exec(s)[1]);
  ok("startxref points at the xref table", s.slice(xrefAt, xrefAt + 4) === "xref",
     JSON.stringify(s.slice(xrefAt, xrefAt + 10)));

  // Parse from the offset startxref gave us. Note the table begins with the free
  // entry (object 0), so the first "n" entry is object 1 — an off-by-one here
  // would compare every object against the wrong offset.
  //
  // (A first attempt searched for the last "xref" in the file, which matches the
  // one inside "startxref" and found nothing. The table was fine; the parser
  // was not.)
  const lines = s.slice(xrefAt).split("\n");
  ok("xref declares its range", /^\d+ \d+$/.test(lines[1]), lines[1]);
  ok("object 0 is the free entry", /^0000000000 65535 f/.test(lines[2]), lines[2]);

  let offsetsGood = true, checked = 0;
  for (let i = 3; i < lines.length; i++) {
    const m = /^(\d{10}) 00000 n/.exec(lines[i]);
    if (!m) break;
    const objNum = i - 2;                     // line 3 == object 1
    const at = Number(m[1]);
    if (!new RegExp(`^${objNum} 0 obj`).test(s.slice(at, at + 20))) {
      offsetsGood = false;
      console.log(`       object ${objNum} claims offset ${at}, found ` +
                  JSON.stringify(s.slice(at, at + 14)));
    }
    checked++;
  }
  ok(`every xref offset resolves (${checked} objects)`, offsetsGood && checked >= 5);
  ok("the trailer follows the table", s.slice(xrefAt).includes("trailer"));

  // Stream /Length must be the BYTE length, not the character count. Checked on
  // a document containing MULTI-BYTE text, since for pure ASCII the two are
  // identical and the check would pass either way — which is exactly how a
  // "measured in characters" bug hides until the first customer named José.
  const multibyte = build(
    INV({ client_name: "José Señor", notes: "Café — naïve — ₹ résumé" }),
    [{ description: "Dragon — Large ★", qty: 1, rate: 100 }],
  );
  const ms = asText(multibyte);
  let lengthsGood = true, streamsChecked = 0;
  for (const m of ms.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const declared = Number(m[1]);
    const start = m.index + m[0].length;
    // asText decodes latin1, so one JS char == one byte here — the declared
    // length must land exactly on "endstream".
    if (!ms.slice(start + declared).trimStart().startsWith("endstream")) lengthsGood = false;
    streamsChecked++;
  }
  ok(`stream lengths are byte-accurate (${streamsChecked} streams, multi-byte content)`,
     lengthsGood && streamsChecked > 0);

  // And the xref must survive multi-byte content too — this is the other half of
  // the same bug.
  const mXrefAt = Number(/startxref\s+(\d+)/.exec(ms)[1]);
  ok("xref still resolves with multi-byte text", ms.slice(mXrefAt, mXrefAt + 4) === "xref",
     JSON.stringify(ms.slice(mXrefAt, mXrefAt + 10)));
}

// ── the numbers ───────────────────────────────────────────────────
section("the money on the PDF is the money charged");
{
  const cases = [
    ["plain", INV({ shipping: 0 }), [{ description: "Thing", qty: 1, rate: 100 }], "100.00"],
    ["with shipping and a discount", INV(), ITEMS, "1,098.00"],
    ["large amount grouping", INV({ shipping: 0 }),
      [{ description: "Big", qty: 1, rate: 123456.5 }], "1,23,456.50"],
    ["multi-quantity", INV({ shipping: 0 }),
      [{ description: "Set", qty: 7, rate: 349 }], "2,443.00"],
  ];
  for (const [label, inv, items, expect] of cases) {
    const s = asText(build(inv, items));
    ok(`${label} → total ${expect}`, s.includes(expect), "not found in the content stream");
  }
}
{
  // Indian digit grouping, not Western. 1,23,456 — a Western 123,456 on an
  // invoice for an Indian customer reads as wrong.
  const s = asText(build(INV({ shipping: 0 }), [{ description: "X", qty: 1, rate: 1234567 }]));
  ok("uses Indian lakh grouping", s.includes("12,34,567.00"), "expected 12,34,567.00");
  ok("not western grouping", !s.includes("1,234,567.00"));
}

// ── escaping ──────────────────────────────────────────────────────
//
// Unescaped parentheses in a product name terminate the string operator early
// and produce a file no reader can open. This is the single most likely way a
// real order breaks the PDF, because product names contain brackets.
section("hostile strings cannot break the file");
{
  const nasty = [
    ["parentheses", "Dragon (Large) — 2 pcs"],
    ["backslash", "Path\\to\\thing"],
    ["unbalanced open", "Broken ( thing"],
    ["unbalanced close", "Broken ) thing"],
    ["newlines", "Line one\nLine two"],
    ["emoji", "Dragon 🐉 print"],
    ["accented", "Café Señor"],
    ["rupee sign", "₹500 voucher"],
  ];
  for (const [label, name] of nasty) {
    const pdf = build(INV(), [{ description: name, qty: 1, rate: 100 }]);
    const s = asText(pdf);
    ok(`${label} still produces a valid file`,
       s.startsWith("%PDF") && s.trimEnd().endsWith("%%EOF"));

    // Every ( and ) inside a text string must be BACKSLASH-ESCAPED.
    //
    // An earlier version only checked that some balanced string existed
    // somewhere, which passed even with escaping removed entirely — the file
    // still opened, and the item line silently vanished from it. A PDF that
    // quietly drops the thing the customer bought is the worst failure here,
    // because it looks fine.
    //
    // So: pull out every string operand and require that no unescaped bracket
    // survives inside one.
    let unescaped = 0;
    for (const m of s.matchAll(/BT[\s\S]*?\((.*?)\)\s*Tj/g)) {
      const body = m[1];
      // Walk the operand; an unescaped ( or ) is a corruption.
      for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\") { i++; continue; }
        if (body[i] === "(" || body[i] === ")") unescaped++;
      }
    }
    ok(`${label} — no unescaped brackets in any string`, unescaped === 0, `${unescaped} found`);
  }
}
{
  // And the behavioural check: the item must still be READABLE afterwards.
  // Structure alone is not enough — the failing case produced a valid file with
  // the product missing.
  const pdf = build(INV(), [{ description: "Dragon (Large) 2pcs", qty: 1, rate: 100 }]);
  const s = asText(pdf);
  ok("a bracketed product name survives escaping",
     s.includes("Dragon \\(Large\\) 2pcs"),
     "the escaped form is not in the content stream");
  // ₹ has no WinAnsi codepoint, so emitting it raw gives a garbled glyph or
  // nothing. It must be transliterated.
  //
  // Checked on the RAW BYTES, not the latin1-decoded string: asText() maps each
  // byte to a char, so a UTF-8 ₹ appears as "â\x82¹" and a naive
  // `!s.includes("₹")` passes even when the character is there. That is why the
  // first version of this test survived deleting the transliteration entirely.
  const bytes = build(INV(), [{ description: "₹500 voucher", qty: 1, rate: 100 }]);
  const rupeeUtf8 = [0xE2, 0x82, 0xB9];
  let foundRupee = false;
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === rupeeUtf8[0] && bytes[i + 1] === rupeeUtf8[1] && bytes[i + 2] === rupeeUtf8[2]) {
      foundRupee = true; break;
    }
  }
  ok("no raw rupee bytes in the file", !foundRupee);
  ok("it became Rs. instead", asText(bytes).includes("Rs.500 voucher"),
     "expected the transliterated form in the content stream");

  // Nothing outside printable WinAnsi may reach a content stream.
  let nonAscii = 0;
  for (const m of asText(bytes).matchAll(/\((.*?)\)\s*Tj/g)) {
    for (const ch of m[1]) {
      const c = ch.charCodeAt(0);
      if (c > 0x7E && !(c >= 0xA0 && c <= 0xFF)) nonAscii++;
    }
  }
  ok("no unencodable characters in any string", nonAscii === 0, `${nonAscii} found`);
}

// ── layout ────────────────────────────────────────────────────────
section("layout holds up");
{
  // 40 items must paginate rather than run off the bottom.
  const many = Array.from({ length: 40 }, (_, i) =>
    ({ description: `Item number ${i + 1}`, qty: 1, rate: 100 }));
  const s = asText(build(INV(), many));
  const pageCount = (s.match(/\/Type \/Page[^s]/g) || []).length;
  ok("40 items paginate", pageCount > 1, `${pageCount} pages`);
  ok("pages are numbered when there are several", s.includes("Page 1 of"));

  const one = asText(build(INV(), ITEMS));
  ok("a short invoice stays on one page", (one.match(/\/Type \/Page[^s]/g) || []).length === 1);
  ok("and is not page-numbered", !one.includes("Page 1 of"));
}
{
  // A very long description must be truncated, not allowed to overrun the Qty
  // column.
  const long = "A".repeat(300);
  const s = asText(build(INV(), [{ description: long, qty: 1, rate: 100 }]));
  ok("a 300-char description is truncated", !s.includes("A".repeat(200)));
  ok("and ends with an ellipsis", s.includes("..."));
}
{
  // Empty-ish invoices must not throw.
  ok("no items does not crash", (() => {
    try { build(INV(), []); return true; } catch { return false; }
  })());
  ok("missing business details do not crash", (() => {
    try {
      build(INV({ biz_name: "", biz_addr: "", biz_pay: "", client_addr: "", notes: "" }), ITEMS);
      return true;
    } catch { return false; }
  })());
}

// ── base64 ────────────────────────────────────────────────────────
section("base64 encoding for the email attachment");
{
  const pdf = build(INV(), ITEMS);
  const b64 = toBase64(pdf);
  ok("is valid base64", /^[A-Za-z0-9+/]+=*$/.test(b64));
  ok("round-trips byte for byte", (() => {
    const back = Buffer.from(b64, "base64");
    return back.length === pdf.length && back.every((v, i) => v === pdf[i]);
  })());
  // The chunked loop exists because String.fromCharCode on a whole large array
  // exceeds the argument limit — exercise a size that would trigger it.
  const big = build(INV(), Array.from({ length: 300 }, (_, i) =>
    ({ description: `Item ${i}`, qty: 1, rate: 100 })));
  ok("a large PDF encodes without blowing the arg limit", toBase64(big).length > 0,
     `${big.length} bytes`);
}

// ── files for the external verifier ───────────────────────────────
//
// Written for test/pdf-verify.sh, which runs pdftotext and pypdf over them. That
// is the check that matters: an independent parser reading the numbers back.
writeFileSync("/tmp/pdftest-simple.pdf", build(INV(), ITEMS));
writeFileSync("/tmp/pdftest-multipage.pdf",
  build(INV(), Array.from({ length: 40 }, (_, i) =>
    ({ description: `Item number ${i + 1}`, qty: 2, rate: 149.5 }))));
writeFileSync("/tmp/pdftest-nasty.pdf",
  build(INV({ client_name: "José (Test) \\ Buyer" }),
    [{ description: "Dragon (Large) — 2 pcs", qty: 1, rate: 1299 }]));
writeFileSync("/tmp/pdftest-gst.pdf",
  build(INV({ tax_mode: "gst", tax_rate: 18, biz_gst: "33ABCDE1234F1Z5" }), ITEMS));

console.log(`\n  pdf: ${pass} passed, ${fail} failed`);
console.log("  wrote 4 files to /tmp for test/pdf-verify.sh");
process.exit(fail ? 1 : 0);
