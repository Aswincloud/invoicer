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
// invoice-pdf.js's Page.rect() emits `re f`. Drawing modules as vectors keeps
// them sharp on a 203dpi thermal head in a way no raster would be. Only email
// needs real pixels, and that encoder lives in bitmap.js because the signature
// needs it too.

import qrcode from "qrcode-generator";
import { png1bit } from "./bitmap.js";

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

/* A base64 PNG of the QR, black on white, `scale` pixels per module and the
   required quiet zone included. Returns "" for an empty matrix so callers can
   treat "no shop url" as "no attachment" without a special case. */
export function qrPngBase64(matrix, scale = 6) {
  if (!matrix || !matrix.length) return "";
  return png1bit(matrix.length, matrix.length, (x, y) => matrix[y][x], scale, QR_QUIET);
}
