// The QR has to actually scan.
//
// Structural checks — "it made a 29x29 grid", "the PNG starts with the right
// magic bytes" — would pass on a QR that no phone can read. So this decodes:
// the matrix is rendered to pixels and handed to a real QR reader (jsQR, the
// same algorithm class as a phone camera), and the emailed PNG is decoded back
// to pixels first. If the URL does not come out the other side, it fails.
//
// What this cannot prove is print quality — whether the modules land on whole
// printer dots and survive a thermal head. That needs paper and a phone, and is
// listed in the plan's verification steps.

import jsQR from "jsqr";
import { PNG } from "pngjs";
import { qrMatrix, qrToRows, qrPngBase64, QR_QUIET } from "../src/qr.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

const URL_3DP = "https://shop.aswincloud.com/3dprints";

// Matrix -> RGBA, the way a camera would see it: dark modules black, quiet zone
// white. jsQR needs the margin as much as a phone does.
function matrixToRgba(m, scale = 4) {
  const n = m.length;
  const side = (n + QR_QUIET * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!m[r][c]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const px = (((r + QR_QUIET) * scale + y) * side + (c + QR_QUIET) * scale + x) * 4;
          data[px] = data[px + 1] = data[px + 2] = 0;
        }
      }
    }
  }
  return { data, side };
}

console.log("— the matrix —");
const m = qrMatrix(URL_3DP);
check("produces a matrix", Array.isArray(m) && m.length > 0);
check("is square", m.every((row) => row.length === m.length), `${m.length}x${m[0].length}`);
check("size is a legal QR version (4v+17)", (m.length - 17) % 4 === 0, String(m.length));
check("empty input yields nothing to draw", qrMatrix("") === null && qrMatrix(null) === null);

console.log("\n— a reader can read it —");
const { data, side } = matrixToRgba(m);
const decoded = jsQR(data, side, side);
check("decodes at all", Boolean(decoded), decoded ? "" : "jsQR returned null");
check("decodes to the exact URL", decoded && decoded.data === URL_3DP, decoded && decoded.data);

console.log("\n— awkward content still round-trips —");
for (const text of [
  "https://shop.example.com/a?b=1&c=2#frag",
  "https://example.com/" + "x".repeat(120),          // forces a larger version
  "UPI://pay?pa=aswin@okicici&pn=Aswin3DPrints",
]) {
  const mm = qrMatrix(text);
  const r = matrixToRgba(mm);
  const d = jsQR(r.data, r.side, r.side);
  check(`round-trips (${mm.length}x${mm.length}) ${text.slice(0, 34)}…`,
    Boolean(d) && d.data === text, d ? "" : "no decode");
}

console.log("\n— the emailed PNG —");
const b64 = qrPngBase64(m, 6);
check("produces base64", typeof b64 === "string" && b64.length > 100);
check("no matrix means no attachment", qrPngBase64(null) === "" && qrPngBase64([]) === "");

const buf = Buffer.from(b64, "base64");
check("has the PNG signature",
  buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

// pngjs validates every chunk CRC as it parses, so a successful parse is the
// CRC check — a hand-rolled encoder getting those wrong is exactly the failure
// that would show up as a broken image in a mail client and nowhere else.
let png = null;
try { png = PNG.sync.read(buf); } catch (e) { console.log("   parse error:", e.message); }
check("decodes as a valid PNG (chunk CRCs included)", Boolean(png));
if (png) {
  const expected = (m.length + QR_QUIET * 2) * 6;
  check("is the expected size", png.width === expected && png.height === expected,
    `${png.width}x${png.height} vs ${expected}`);
  const fromPng = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  check("the PNG itself decodes to the URL", fromPng && fromPng.data === URL_3DP,
    fromPng ? fromPng.data : "no decode");
}

console.log("\n— the wire format for the browser —");
const rows = qrToRows(m);
check("one string per row", Array.isArray(rows) && rows.length === m.length);
check("only 0 and 1", rows.every((r) => /^[01]+$/.test(r)));
check("round-trips back to the matrix",
  rows.every((r, y) => [...r].every((ch, x) => (ch === "1") === m[y][x])));
check("null matrix yields null", qrToRows(null) === null);

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
