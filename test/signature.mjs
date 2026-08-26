// The signature: stored as bits, drawn four different ways.
//
// The interesting failure here is not "no signature appeared" — it is a
// signature that appears WRONG. A PDF /ImageMask with its Decode array the
// wrong way round produces a solid navy rectangle with the signature knocked
// out of it, and every structural assertion still passes: the object is there,
// the stream length is right, the file opens. So the PDF is rasterised in
// test/signature-verify.sh and looked at; what is checked here is everything
// that can be checked without eyes.

import { parseSignature, signInk, signPngBase64, signStride } from "../src/signature.js";
import { renderInvoiceEmail, computeTotals, signAttachment } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";
import { PNG } from "pngjs";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

// 16x4: row 0 solid, row 1 alternating, rows 2-3 blank. Two bytes per row.
const BITS = Uint8Array.from([0xff, 0xff, 0xaa, 0xaa, 0x00, 0x00, 0x00, 0x00]);
const MASK = `16:4:${Buffer.from(BITS).toString("base64")}`;

console.log("— the mask —");
const sig = parseSignature(MASK);
check("parses", Boolean(sig) && sig.w === 16 && sig.h === 4, sig && `${sig.w}x${sig.h}`);
check("stride is bytes per row", signStride(16) === 2 && signStride(17) === 3);
check("row 0 is all ink", [...Array(16)].every((_, x) => signInk(sig, x, 0)));
check("row 1 alternates", [...Array(16)].every((_, x) => signInk(sig, x, 1) === (x % 2 === 0)));
check("row 3 is blank", [...Array(16)].every((_, x) => !signInk(sig, x, 3)));

console.log("\n— a corrupt value draws nothing, rather than garbage —");
check("wrong length rejected", parseSignature("16:5:" + Buffer.from(BITS).toString("base64")) === null);
check("nonsense rejected", parseSignature("not-a-mask") === null);
check("empty rejected", parseSignature("") === null && parseSignature(null) === null);
check("absurd dimensions rejected", parseSignature("99999:1:AA==") === null);

console.log("\n— the PNG for email —");
const b64 = signPngBase64(MASK, 3);
const png = PNG.sync.read(Buffer.from(b64, "base64"));   // parsing validates every CRC
check("decodes as a valid PNG", Boolean(png));
check("scaled correctly", png.width === 48 && png.height === 12, `${png.width}x${png.height}`);
const at = (x, y) => png.data[(y * png.width + x) * 4];
check("ink is black", at(1, 1) === 0, String(at(1, 1)));
check("paper is white", at(1, 10) === 255, String(at(1, 10)));
check("no mask means no attachment", signPngBase64("") === "");

console.log("\n— email —");
const INV = { number: "INV-1", currency: "₹", tax_mode: "none", status: "UNPAID",
              biz_name: "Aswin3DPrints", biz_sign: MASK };
const ITEMS = [{ description: "Benchy", qty: 1, rate: 250 }];

const withSig = renderInvoiceEmail(INV, ITEMS, { signSrc: "cid:signature@invoicer" });
check("renders the image when a src is passed", withSig.includes("cid:signature@invoicer"));
check("keeps the printed line too", withSig.includes("Authorised Signatory"));

// This is the mechanism that keeps it off the public pay page: sharePage calls
// the same template and passes no signature.
const noSig = renderInvoiceEmail(INV, ITEMS, {});
check("renders NOTHING when no src is passed", !noSig.includes("signature@invoicer"),
  "this is what keeps it off /i/<token>");
check("the signatory line still prints there", noSig.includes("Authorised Signatory"));

const att = signAttachment(INV);
check("builds a CID attachment", Boolean(att) && att.src === "cid:signature@invoicer");
check("as a PNG", att && att.attachment.content_type === "image/png"
  && att.attachment.content_id === "signature@invoicer");
check("no signature, no attachment", signAttachment({ biz_name: "X" }) === null);

console.log("\n— PDF —");
const pdfBytes = renderInvoicePdf(INV, ITEMS, computeTotals(INV, ITEMS));
const pdf = new TextDecoder("latin1").decode(pdfBytes);
check("embeds an image XObject", pdf.includes("/Subtype /Image"));
check("as an ImageMask", pdf.includes("/ImageMask true"));
check("with the decode array that makes a set bit paint", pdf.includes("/Decode [1 0]"));
check("declares it in page resources", /\/XObject << \/Sig \d+ 0 R >>/.test(pdf));
check("draws it", pdf.includes("/Sig Do"));
check("dimensions match the mask", pdf.includes("/Width 16") && pdf.includes("/Height 4"));

// The xref table records a byte offset per object and is hand-computed. Adding
// an object shifts it, and a wrong offset is a file no reader will open.
const declared = Number(/\/Size (\d+)/.exec(pdf)[1]);
const startxref = Number(/startxref\s+(\d+)/.exec(pdf)[1]);
check("startxref points at the xref table",
  pdf.slice(startxref, startxref + 4) === "xref", JSON.stringify(pdf.slice(startxref, startxref + 12)));

// Sliced from the recorded offset, NOT from lastIndexOf("xref") — that finds
// the "xref" inside "startxref" and lands past the table entirely.
const xrefRows = (pdf.slice(startxref).match(/^\d{10} \d{5} [nf] $/gm) || []).length;
check("xref has one row per declared object", xrefRows === declared, `${xrefRows} vs ${declared}`);

// The offsets must actually point at their objects, which is the thing that
// silently breaks when an object is added.
const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) \d{5} n $/gm)].map((m) => Number(m[1]));
const misaimed = offsets.filter((off, i) => !/^\d+ 0 obj/.test(pdf.slice(off, off + 20)));
check("every xref offset lands on an object header", misaimed.length === 0,
  misaimed.length ? `${misaimed.length} of ${offsets.length} wrong` : `${offsets.length} checked`);

const noSigPdf = new TextDecoder("latin1")
  .decode(renderInvoicePdf({ ...INV, biz_sign: "" }, ITEMS, computeTotals(INV, ITEMS)));
check("no signature means no XObject at all", !noSigPdf.includes("/Subtype /Image"));
check("and that PDF is still well-formed", noSigPdf.startsWith("%PDF-") && noSigPdf.includes("%%EOF"));

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
