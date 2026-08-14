// QR codes for the "order online" link, in one place.
//
// A business can carry a shop URL. When it does, that link is printed as a QR on
// its paperwork: the counter receipt, the A4 invoice and the emailed copy.
//
// The matrix is built HERE, on the server, and never in the browser. The client
// cannot import from src/ (public/ is served statically, src/ is bundled — see
// the note above fmtDate in public/app.js about rules having to live twice), so
// a client-side encoder would mean a second QR implementation to keep in step.
// It does not need one: the URL is a fixed property of the business, so the
// matrix is computed once here and shipped with the profile. Every surface draws
// the same modules.
//
// Nothing here rasterises for the two PDFs either. A QR is a grid of squares and
// both PDF writers can already fill a rectangle — jsPDF has rect(), and
// invoice-pdf.js's Page.rect() emits `re f`. Drawing modules as vectors avoids
// teaching the hand-rolled PDF writer about image XObjects, and prints sharper
// on a 203dpi thermal head than any raster would. Only email needs real pixels,
// which is what qrPngBase64 is for.

import qrcode from "qrcode-generator";

// Four modules of blank margin. This is not padding to taste — the QR spec
// requires it, and a reader will simply fail to find a code that runs to the
// edge of the ink. It is the single most common way a printed QR does not scan.
export const QR_QUIET = 4;

/* The QR for `text` as rows of booleans, true meaning a dark module.

   Error correction M: ~15% recoverable. L would make a slightly smaller code,
   but this one is going onto thermal paper that gets folded into a pocket, and
   the recovery is worth the modules. Version 0 lets the library pick the
   smallest that fits. */
export function qrMatrix(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const q = qrcode(0, "M");
  q.addData(s);
  q.make();

  const n = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/* The matrix as one compact string per row ("0110…"), for shipping to the
   browser in the profile payload. Cheaper than nested JSON arrays and trivially
   readable back with charAt. */
export const qrToRows = (m) => (m ? m.map((row) => row.map((d) => (d ? "1" : "0")).join("")) : null);

// ── PNG, for email ───────────────────────────────────────────────────────────
//
// Email is the one surface that cannot take vectors, so the QR is attached as a
// real image the way the logo already is (see logoAttachment in
// invoice-html.js). Written by hand rather than pulled in as a dependency
// because a QR is the easiest possible PNG: 8-bit greyscale, no palette, no
// transparency, and — critically — no compression to implement. Deflate has a
// "stored" mode that is literally a length followed by the bytes, which is all
// this uses. A few dozen KB on an invoice email is not worth a compressor.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes) => {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type, data) {
  const name = [...type].map((ch) => ch.charCodeAt(0));
  const body = Uint8Array.from([...name, ...data]);
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

// Deflate with every block stored uncompressed: BFINAL/BTYPE byte, LEN, ~LEN,
// then the bytes themselves.
function storedDeflate(raw) {
  const out = [0x78, 0x01];                 // zlib header, 0x7801 % 31 === 0
  const MAX = 65535;
  for (let off = 0; off < raw.length || off === 0; off += MAX) {
    const slice = raw.subarray(off, Math.min(off + MAX, raw.length));
    const last = off + MAX >= raw.length ? 1 : 0;
    out.push(last, slice.length & 255, (slice.length >>> 8) & 255,
             ~slice.length & 255, (~slice.length >>> 8) & 255);
    for (let i = 0; i < slice.length; i++) out.push(slice[i]);
    if (last) break;
  }
  out.push(...be32(adler32(raw)));
  return out;
}

/* A base64 PNG of the QR, black on white, `scale` pixels per module and the
   required quiet zone included. Returns "" for an empty matrix so callers can
   treat "no shop url" as "no attachment" without a special case. */
export function qrPngBase64(matrix, scale = 6) {
  if (!matrix || !matrix.length) return "";

  const n = matrix.length;
  const side = (n + QR_QUIET * 2) * scale;

  // One filter byte (0 = none) per row, then one grey byte per pixel.
  const raw = new Uint8Array(side * (side + 1));
  raw.fill(0xff);
  for (let y = 0; y < side; y++) raw[y * (side + 1)] = 0;

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      const y0 = (r + QR_QUIET) * scale;
      const x0 = (c + QR_QUIET) * scale;
      for (let y = y0; y < y0 + scale; y++) {
        const base = y * (side + 1) + 1 + x0;
        for (let x = 0; x < scale; x++) raw[base + x] = 0;
      }
    }
  }

  const ihdr = [...be32(side), ...be32(side), 8, 0, 0, 0, 0];  // 8-bit greyscale
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", storedDeflate(raw)),
    ...chunk("IEND", []),
  ]);

  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
