// A real PDF, generated in the Worker. No dependencies, no browser.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Invoicer has had a PDF download since the beginning, but it runs in the
// BROWSER: html2canvas screenshots the invoice element and jsPDF wraps the
// bitmap. That is fine when a human has the invoice open, and useless for an
// invoice raised automatically from a paid order — one Worker calling another,
// with no DOM to screenshot.
//
// So this writes the PDF file format directly. It is less code than it sounds:
// a PDF is a handful of objects, a content stream of text-positioning operators,
// and a cross-reference table. The base-14 fonts (Helvetica and friends) are
// built into every reader, so nothing needs embedding.
//
// The output is BETTER than the browser one, not a compromise: real text rather
// than a JPEG of text, so it is selectable, searchable, sharp at any zoom, and
// about 4KB instead of ~300KB.
//
// ── The currency ─────────────────────────────────────────────────────────────
//
// Base-14 fonts use WinAnsiEncoding, which has no ₹ (U+20B9) — writing it raw
// gives a garbled glyph or nothing at all. Embedding a font that has it would
// mean shipping a TTF subsetter for one character.
//
// The PDF writes "Rs." instead. It is unambiguous, standard on Indian invoices,
// and renders in every reader. The HTML email — which is the primary document —
// still shows ₹ properly.

// The one import: deciding what sits where "PAY TO" goes is a rule about the
// document, not about PDF drawing, and a second copy of it here is how the PDF
// and the email would end up disagreeing on a paid invoice.
import { paymentBlock, fmtDate, amountInWords, placeOfSupply, plain,
         itemUnits, fmtUnits } from "./invoice-html.js";
import { qrMatrix, QR_QUIET } from "./qr.js";

const PT = 1;                     // PDF unit is the point
const PAGE_W = 595.28;            // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Column x-positions for the item table, measured from the left margin.
const COL_DESC = MARGIN;
const COL_QTY = MARGIN + 300;
const COL_RATE = MARGIN + 370;
const COL_AMT = PAGE_W - MARGIN;  // right-aligned

const FONT_REG = "F1";            // Helvetica
const FONT_BOLD = "F2";           // Helvetica-Bold

// Helvetica advance widths (1/1000 em) for the WinAnsi range we can print.
// Needed for right-alignment and for truncating long descriptions: without real
// widths, "right-aligned" means guessing, and amounts that do not line up are
// the first thing that makes an invoice look homemade.
const W_REG = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];
const W_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
];

// Width of a string at a given size. Characters outside the table fall back to
// an average — they are rare in an invoice and a few points of drift on an
// exotic glyph beats refusing to render.
function textWidth(s, size, bold = false) {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    w += (c >= 32 && c <= 126) ? table[c - 32] : 556;
  }
  return (w * size) / 1000;
}

// Break an address into display lines.
//
// Splitting on every comma turns "12 Test St, Chennai, TN, 600001" into four
// stacked lines, which reads like a form dump rather than an address. Real
// addresses are written with the city and PIN together, so short trailing
// fragments are re-joined until each line is a sensible width.
function addressLines(s, maxW, size) {
  const parts = String(s || "").split(/\s*,\s*|\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && textWidth(last + ", " + part, size) <= maxW) {
      out[out.length - 1] = last + ", " + part;
    } else {
      out.push(part);
    }
  }
  return out;
}

// Cut a string to fit, with an ellipsis. Long product names are the realistic
// case — "Temple Gopuram — Two-Tone (Large)" is wider than the description
// column, and letting it run would collide with the Qty figures.
function fit(s, maxW, size, bold = false) {
  let out = String(s ?? "");
  if (textWidth(out, size, bold) <= maxW) return out;
  while (out.length > 1 && textWidth(out + "...", size, bold) > maxW) {
    out = out.slice(0, -1);
  }
  return out + "...";
}

// PDF strings are parenthesised, so ( ) and \ must be escaped or the file is
// structurally broken — a product name containing a bracket would otherwise
// produce a PDF that no reader can open.
//
// Non-WinAnsi characters are transliterated rather than dropped: ₹ becomes Rs.,
// typographic dashes and quotes become their ASCII equivalents. A customer
// called "José" should not appear as "Jos".
function pdfString(s) {
  const mapped = String(s ?? "")
    .replace(/₹/g, "Rs.")
    .replace(/[‒-―−]/g, "-")   // dashes
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")    // non-breaking spaces
    .replace(/[^\x20-\x7E]/g, (ch) => {
      // Latin-1 letters are printable in WinAnsi; anything else becomes '?' so
      // the layout does not silently shift.
      const c = ch.charCodeAt(0);
      return (c >= 0xA0 && c <= 0xFF) ? ch : "?";
    });
  return mapped.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// ── content-stream builder ───────────────────────────────────────────────────
class Page {
  constructor() { this.ops = []; }

  text(x, y, s, { size = 9.5, bold = false, color = null, align = "left" } = {}) {
    const str = pdfString(s);
    if (!str) return;
    let tx = x;
    if (align === "right") tx = x - textWidth(String(s).replace(/₹/g, "Rs."), size, bold);
    if (color) this.ops.push(`${color} rg`);
    this.ops.push(`BT /${bold ? FONT_BOLD : FONT_REG} ${size} Tf ${tx.toFixed(2)} ${y.toFixed(2)} Td (${str}) Tj ET`);
    if (color) this.ops.push("0 0 0 rg");
  }

  line(x1, y1, x2, y2, { width = 0.5, color = "0.85 0.86 0.85" } = {}) {
    this.ops.push(`${color} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  rect(x, y, w, h, color) {
    this.ops.push(`${color} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 0 0 rg`);
  }

  toStream() { return this.ops.join("\n"); }
}

// ── the document ─────────────────────────────────────────────────────────────
//
// Takes the same (inv, items, totals) the HTML renderer does, so the two cannot
// disagree about what is on the invoice.
export function renderInvoicePdf(inv, items, totals) {
  const money = (n) => "Rs. " + Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  const pages = [];
  let p = new Page();
  pages.push(p);
  let y = PAGE_H - MARGIN;

  // ── header ──
  p.text(MARGIN, y - 10, inv.biz_name || "Your Business", { size: 16, bold: true });
  p.text(PAGE_W - MARGIN, y - 8, "INVOICE", { size: 18, bold: true, color: "0.18 0.49 0.33", align: "right" });
  y -= 26;

  for (const l of addressLines(inv.biz_addr, 250, 8.5)) {
    p.text(MARGIN, y, l, { size: 8.5, color: "0.36 0.39 0.45" });
    y -= 11;
  }
  // Phone AND email. The phone was on the screen invoice and in neither the PDF
  // nor the email, so every copy actually sent to a client had no number on it.
  const contact = [inv.biz_phone, inv.biz_email].filter(Boolean).join("  ·  ");
  if (contact) { p.text(MARGIN, y, contact, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 11; }
  if (inv.biz_gst) { p.text(MARGIN, y, "GSTIN: " + inv.biz_gst, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 11; }

  // Invoice meta, right column, aligned with the header block above.
  let my = PAGE_H - MARGIN - 30;
  const meta = [["No.", inv.number], ["Issued", fmtDate(inv.issue_date)]];
  if (inv.due_date) meta.push(["Due", fmtDate(inv.due_date)]);
  if (inv.status) meta.push(["Status", inv.status]);
  for (const [k, v] of meta) {
    p.text(PAGE_W - MARGIN - 110, my, k, { size: 8.5, color: "0.36 0.39 0.45" });
    p.text(PAGE_W - MARGIN, my, v, { size: 8.5, bold: true, align: "right" });
    my -= 12;
  }

  y = Math.min(y, my) - 10;
  p.line(MARGIN, y, PAGE_W - MARGIN, y, { width: 1.2, color: "0.11 0.12 0.14" });
  y -= 22;

  // ── billed to / pay to ──
  const blockTop = y;
  p.text(MARGIN, y, "BILLED TO", { size: 7.5, bold: true, color: "0.36 0.39 0.45" });
  y -= 13;
  p.text(MARGIN, y, inv.client_name || "Client", { size: 10.5, bold: true });
  y -= 12;
  for (const l of addressLines(inv.client_addr, 260, 8.5)) {
    p.text(MARGIN, y, l, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 10.5;
  }
  if (inv.client_email) { p.text(MARGIN, y, inv.client_email, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 10.5; }
  if (inv.client_gst) { p.text(MARGIN, y, "GSTIN: " + inv.client_gst, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 10.5; }
  // Required on a GST invoice; derived from the client's GSTIN state code, the
  // same two digits the editor already uses to choose CGST+SGST vs IGST.
  const pos = placeOfSupply(inv);
  if (pos) { p.text(MARGIN, y, "Place of supply: " + pos, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 10.5; }

  // Pay-to on an unpaid invoice; the Razorpay reference once it is settled.
  // See paymentBlock() — a paid receipt must not carry payment instructions.
  const pay = paymentBlock(inv);
  let ry = blockTop;
  p.text(PAGE_W - MARGIN, ry, pay.label.toUpperCase(),
    { size: 7.5, bold: true, align: "right",
      color: pay.kind === "paid" ? "0.18 0.49 0.33" : "0.36 0.39 0.45" });
  ry -= 13;
  for (const l of pay.lines) {
    p.text(PAGE_W - MARGIN, ry, l, { size: 8.5, color: "0.36 0.39 0.45", align: "right" });
    ry -= 10.5;
  }

  y = Math.min(y, ry) - 18;

  // ── item table ──
  const header = () => {
    p.text(COL_DESC, y, "DESCRIPTION", { size: 7.5, bold: true, color: "0.36 0.39 0.45" });
    p.text(COL_QTY, y, "QTY", { size: 7.5, bold: true, color: "0.36 0.39 0.45", align: "right" });
    p.text(COL_RATE, y, "RATE", { size: 7.5, bold: true, color: "0.36 0.39 0.45", align: "right" });
    p.text(COL_AMT, y, "AMOUNT", { size: 7.5, bold: true, color: "0.36 0.39 0.45", align: "right" });
    y -= 6;
    p.line(MARGIN, y, PAGE_W - MARGIN, y, { width: 1, color: "0.11 0.12 0.14" });
    y -= 16;
  };
  header();

  const visible = items.filter((i) => i.description || i.qty || i.rate);
  for (const it of visible) {
    // New page when we run out of room. The totals block needs ~120pt, so break
    // early enough that it never lands orphaned on its own page.
    if (y < MARGIN + 140) {
      p = new Page();
      pages.push(p);
      y = PAGE_H - MARGIN;
      header();
    }
    const amt = (it.qty || 0) * (it.rate || 0);
    // Regular weight, matching the on-screen sheet. Bold here made the emailed
    // PDF read as a different document from the one the invoice is designed as.
    p.text(COL_DESC, y, fit(it.description, COL_QTY - COL_DESC - 24, 9), { size: 9 });
    p.text(COL_QTY, y, it.qty ? String(it.qty) : "", { size: 9, color: "0.36 0.39 0.45", align: "right" });
    // A zero rate prints "0.00", not blank: the Amount column beside it already
    // printed 0.00, so a blank here made one row contradict itself, and blank
    // reads as missing data rather than as free.
    p.text(COL_RATE, y, plain(inv.currency, it.rate), { size: 9, color: "0.36 0.39 0.45", align: "right" });
    p.text(COL_AMT, y, money(amt), { size: 9, align: "right" });
    y -= 8;
    p.line(MARGIN, y, PAGE_W - MARGIN, y);
    y -= 15;
  }

  // ── totals ──
  y -= 10;
  const labelX = PAGE_W - MARGIN - 150;
  const totRow = (label, val, opts = {}) => {
    p.text(labelX, y, label, { size: 9, color: opts.strong ? "0.11 0.12 0.14" : "0.36 0.39 0.45", bold: !!opts.strong });
    p.text(COL_AMT, y, (opts.neg ? "- " : opts.pos ? "+ " : "") + money(val), { size: 9, align: "right" });
    y -= 14;
  };

  // Units in the box, above the money. Counts quantities rather than lines —
  // see itemUnits().
  const units = itemUnits(items);
  if (units) {
    p.text(labelX, y, "Items", { size: 9, color: "0.36 0.39 0.45" });
    p.text(COL_AMT, y, fmtUnits(units), { size: 9, color: "0.36 0.39 0.45", align: "right" });
    y -= 14;
  }
  totRow("Subtotal", totals.subtotal);
  if (totals.disc) totRow(`Discount (${inv.discount_pct || 0}%)`, totals.disc, { neg: true });
  if (totals.shipping) {
    totRow(inv.shipping_mode ? `Shipping (${inv.shipping_mode})` : "Shipping", totals.shipping);
  }
  // Same rule as the HTML: "Taxable value" is the base a tax was computed on, so
  // it is meaningless — and misleading — when no tax applies.
  if ((totals.disc || totals.shipping) && totals.taxRows.length) totRow("Taxable value", totals.taxable);
  for (const [l, v] of totals.taxRows) totRow(l, v);
  // Signed, like the screen: "Round off  0.40" leaves the reader to work out
  // which way it moved the total.
  if (Math.abs(totals.round) >= 0.005)
    totRow("Round off", Math.abs(totals.round), { neg: totals.round < 0, pos: totals.round > 0 });

  y -= 4;
  p.line(labelX, y + 8, PAGE_W - MARGIN, y + 8, { width: 1, color: "0.11 0.12 0.14" });
  y -= 6;
  p.text(labelX, y, "TOTAL", { size: 11, bold: true });
  p.text(COL_AMT, y, money(totals.total), { size: 13, bold: true, color: "0.18 0.49 0.33", align: "right" });
  y -= 26;

  // ── amount in words ──
  //
  // Goes on the LEFT, level with where the totals ended: that half of the page
  // was empty, and this is the row an Indian invoice is expected to carry.
  const words = amountInWords(totals.total, inv.currency);
  if (words) {
    p.text(MARGIN, y + 20, "AMOUNT IN WORDS", { size: 7.5, bold: true, color: "0.36 0.39 0.45" });
    let wy = y + 8;
    let line = "";
    for (const word of words.split(" ")) {
      const next = line ? line + " " + word : word;
      if (textWidth(next, 8.5) > CONTENT_W * 0.55) {
        p.text(MARGIN, wy, line, { size: 8.5 }); wy -= 11; line = word;
      } else line = next;
    }
    if (line) { p.text(MARGIN, wy, line, { size: 8.5 }); wy -= 11; }
    y = Math.min(y, wy);
  }
  y -= 18;

  // ── notes ──
  if (inv.notes) {
    p.text(MARGIN, y, "NOTES / TERMS", { size: 7.5, bold: true, color: "0.36 0.39 0.45" });
    y -= 12;
    // Wrap by measured width rather than character count, so a long note does
    // not run off the page.
    for (const para of String(inv.notes).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? line + " " + word : word;
        if (textWidth(next, 8.5) > CONTENT_W) {
          p.text(MARGIN, y, line, { size: 8.5, color: "0.36 0.39 0.45" });
          y -= 11;
          line = word;
        } else line = next;
      }
      if (line) { p.text(MARGIN, y, line, { size: 8.5, color: "0.36 0.39 0.45" }); y -= 11; }
    }
  }

  // ── order-online QR, bottom left ──
  //
  // Drawn as filled rectangles rather than an embedded image. This writer has no
  // image support at all — no XObjects, not even for the logo — and a QR is
  // nothing but a grid of black squares, so vectors avoid that entire machinery
  // and stay sharp at any zoom or print resolution.
  //
  // Runs of adjacent dark modules in a row collapse into ONE rectangle. A 29x29
  // code is 841 modules; emitted individually that is ~34KB of content stream on
  // every invoice, and merging typically cuts it by two thirds for free.
  const qr = qrMatrix(inv.qr_url);
  if (qr) {
    const BOX = 78;                                   // ~27mm including quiet zone
    const mod = BOX / (qr.length + QR_QUIET * 2);
    const qTop = Math.max(y - 18, MARGIN + 108);

    for (let r = 0; r < qr.length; r++) {
      let c = 0;
      while (c < qr.length) {
        if (!qr[r][c]) { c++; continue; }
        let run = 1;
        while (c + run < qr.length && qr[r][c + run]) run++;
        p.rect(MARGIN + (c + QR_QUIET) * mod, qTop - (r + QR_QUIET + 1) * mod,
               run * mod, mod, "0 0 0");
        c += run;
      }
    }

    const caption = String(inv.qr_caption || "").trim() || "Scan to order online";
    p.text(MARGIN, qTop - BOX - 2, fit(caption, 190, 7.5), { size: 7.5, color: "0.36 0.39 0.45" });
  }

  // ── signature ──
  //
  // Bottom right, above the footer rule, on the LAST page only — a signature
  // block repeated on every page would read as several separate approvals.
  const sigY = Math.max(y - 26, MARGIN + 66);
  p.line(PAGE_W - MARGIN - 170, sigY, PAGE_W - MARGIN, sigY, { width: 0.5 });
  p.text(PAGE_W - MARGIN, sigY - 12, "For " + (inv.biz_name || "Your Business"),
         { size: 8, color: "0.36 0.39 0.45", align: "right" });
  p.text(PAGE_W - MARGIN, sigY - 23, "Authorised Signatory",
         { size: 8, color: "0.36 0.39 0.45", align: "right" });

  // ── footer, on every page ──
  //
  // The business's own contact line, not ours: this document goes to their
  // customers, and "Generated with Invoicer" is our branding on their paper.
  const footLine = [inv.biz_name, inv.biz_phone, inv.biz_email].filter(Boolean).join("  ·  ");
  pages.forEach((pg, i) => {
    pg.line(MARGIN, MARGIN + 22, PAGE_W - MARGIN, MARGIN + 22);
    pg.text(MARGIN, MARGIN + 10, footLine, { size: 7.5, color: "0.36 0.39 0.45" });
    if (pages.length > 1) {
      pg.text(PAGE_W - MARGIN, MARGIN + 10, `Page ${i + 1} of ${pages.length}`,
              { size: 7.5, color: "0.36 0.39 0.45", align: "right" });
    }
  });

  return assemble(pages);
}

// ── PDF file assembly ────────────────────────────────────────────────────────
//
// Objects are numbered from 1 and the xref table records each one's BYTE OFFSET
// from the start of the file. Those offsets have to be exact — a reader seeks to
// them directly — which is why the file is built as bytes and measured as bytes,
// not as a string. A single multi-byte character anywhere would shift every
// offset after it and produce a file that opens as blank or corrupt.
function assemble(pages) {
  /* Latin-1, one byte per character — NOT TextEncoder.

     The base-14 fonts use WinAnsiEncoding, which is Latin-1 for everything
     above ASCII, and pdfString() already guarantees nothing above U+00FF
     survives. TextEncoder is UTF-8, so it wrote é as two bytes (C3 A9) and the
     reader dutifully rendered them as the two WinAnsi characters "Ã©".

     Every accented name on every PDF this has ever produced came out mangled —
     "José Ferrão" as "JosÃ© FerrÃ£o". It went unnoticed because the sample data
     was ASCII; a "·" separator in the footer is what finally showed it.

     It also matters for the xref table, whose byte offsets are counted here: a
     multi-byte character shifts every offset after it. */
  const latin1 = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  };
  const chunks = [];
  let length = 0;
  const push = (s) => {
    const b = typeof s === "string" ? latin1(s) : s;
    chunks.push(b);
    length += b.length;
    return length;
  };

  const objects = [];   // 1-indexed; objects[i] = { offset }
  const nPages = pages.length;

  // Object layout:
  //   1        Catalog
  //   2        Pages
  //   3        Font Helvetica
  //   4        Font Helvetica-Bold
  //   5..      Page objects, then their content streams
  const firstPageObj = 5;
  const pageIds = pages.map((_, i) => firstPageObj + i * 2);
  const contentIds = pages.map((_, i) => firstPageObj + i * 2 + 1);

  push("%PDF-1.4\n");
  // A binary comment marks the file as containing binary data — some tools
  // otherwise treat it as text and mangle line endings.
  push("%\xE2\xE3\xCF\xD3\n");

  const obj = (id, body) => {
    objects[id] = length;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${nPages} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  pages.forEach((pg, i) => {
    obj(pageIds[i],
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /${FONT_REG} 3 0 R /${FONT_BOLD} 4 0 R >> >> ` +
      `/Contents ${contentIds[i]} 0 R >>`);

    const stream = pg.toStream();
    // Length must be the byte length of the stream, not its character count —
    // and in the SAME encoding the stream is written with, or /Length lies.
    const bytes = latin1(stream);
    objects[contentIds[i]] = length;
    push(`${contentIds[i]} 0 obj\n<< /Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    push("\nendstream\nendobj\n");
  });

  const xrefOffset = length;
  const count = objects.length;   // objects[0] is the free entry
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    xref += String(objects[i] ?? 0).padStart(10, "0") + " 00000 n \n";
  }
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Base64 for Resend's attachment field. Chunked because String.fromCharCode
// applied to a whole 50KB array blows the argument limit.
export function toBase64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
