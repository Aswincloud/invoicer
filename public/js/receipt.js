/* receipt.js — the 48mm thermal receipt: layout, drawing, download and print.
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
/* ── POS / thermal receipt (57mm) ─────────────────────────────────
   Drawn as text, not a rasterised #paper: thermal heads are ~203dpi and
   1-bit, so a downscaled screenshot of the A4 sheet turns to mush. Real
   text in a mono font stays crisp and the file stays tiny.

   Height is measured first and the page built to fit, so the roll never
   gets a trailing blank feed.

   Width: the page IS the printable width — 48mm, the 384-dot head at 203dpi.

   This is printed with the app's paper size set to 48mm and "fit to paper"
   on, which scales the page to the head. A page that already measures 48mm
   therefore scales 1:1, and every millimetre of it reaches paper.

   Getting here took several wrong turns worth recording, because they all
   shared one mistake: trying to infer the head's window from which glyphs
   survived a 57mm page printed at native size. With no scaling, the head
   simply clips at an unmarked hardware edge, and each indirect reading —
   a striped bar measured with a ruler, a half-cut character, a missing
   ".00" — contradicted the last. Guesses ranged over 48, 50 and 54mm.

   Matching the page to the paper setting sidesteps the question entirely:
   there is no clipping to measure because nothing is drawn outside the
   window. The 1.5mm inset stays as a margin against paper wander; it is a
   choice now, not a workaround for a hardware edge.

   If the paper size is ever set back to 57mm, this must go back to a 57mm
   page — a 48mm page at native size would print two-thirds width. */
const POS_W = 48;                            // = paper size set in the print app
const POS_L = 1.5;                           // margin for paper wander
const POS_R = POS_W - POS_L;                 // 46.5mm
const POS_PAD = POS_L;                       // kept for callers reading POS_PAD
const POS_CONTENT = POS_R - POS_L;           // 45mm of content

/* QR sizing, in printer dots rather than millimetres.

   The head is 384 dots across 48.00mm — exactly 8 dots/mm at 203.2dpi — and
   print-receipt.sh thresholds at 176 with no dithering. A module that is not a
   whole number of dots therefore straddles a dot column and is decided by
   rounding, which shows up as ragged module edges and a code a phone gives up
   on. 6 dots = 0.75mm keeps every module edge on a dot boundary.

   At 6 dots a 29-module (version 3) code is 21.75mm, 27.75mm once the mandatory
   4-module quiet zone is counted — still inside the 45mm content width, with
   room for the version 4 or 5 a longer URL produces. Bigger modules are also
   more forgiving of a worn head and a phone held at an angle, which is the
   actual reason to spend the width.

   Was 4 dots. Anything that pushes a longer URL past 45mm needs a shorter link
   rather than a smaller module — below 4 dots the code stops scanning. */
const DOTS_PER_MM = 8;
const QR_DOTS = 6;
const QR_QUIET_MODULES = 4;

/* Signature width on the receipt: 26mm = 208 dots of the 360 printable.

   Sizes were checked by rasterising the real signature at 203.2dpi and
   thresholding at 176 — the literal pipeline. 30/36/40/45mm were all legible,
   36 was the first choice, and 26 was picked once it was on paper next to a
   larger QR: a signature is an attestation, not a headline, and at 26mm it
   still reads while leaving the QR the width it needs.

   Below about 22mm the thin joining strokes start dropping out at this
   threshold, so this is close to the floor. The aspect ratio is read from the
   mask so a taller or wider signature is not distorted. */
const SIGN_MM = 26;
let SIGN_RATIO = 0.42;

/* Sizes are per role rather than one global multiplier.

   A single scale is capped by the receipt's longest line, and that line is
   always prose: a full street address tops out at 8pt and the thank-you
   footer at 8pt, while the money rows would take 12.75pt. Scaling
   everything together therefore pinned the figures to the prose limit — and
   the line the eye actually judges size by, the grand total, was pulled back
   further by shrink-to-fit (10 -> 10.75pt, a 7% gain that reads as nothing).

   So money and identity are sized for what they need, and long prose is
   allowed to wrap onto a second line instead of holding the rest down.
   Every value below is the measured ceiling for that role against the 48mm
   band, so ordinary receipts fill the width without wrapping. */
/* One knob for the whole receipt.

   Every value below was measured as the ceiling for its role against the 48mm
   band, so scaling them is not free: the roles with headroom (bizName caps at
   14, meta at 13.5) simply get bigger, while the ones already at their limit —
   bizMeta wraps past 8 — start taking a second line. That costs paper, which is
   the trade being made deliberately here rather than discovered later.

   Measured on a full receipt — business address, client address, GSTIN, notes
   — rasterised at 203.2dpi:

     1.00   180.6mm      1.15   203.4mm      1.30   235.5mm
     1.10   194.2mm      1.20   208.8mm

   So 1.15 buys legibility for about 23mm of roll per receipt, roughly 13%.
   That is the trade; it is not free, and pushing to 1.30 costs 55mm.

   `footer` is exempt, and measurably so. "Thank you for your business!" is
   44.45mm wide at 7.5pt against 45mm of content — 0.55mm of headroom. At 8pt it
   is 47.41mm and wraps to two lines, which costs a line of paper to say the same
   thing worse. The footer is the least important text on the receipt and the
   only role with no room at all, so it keeps its measured size. */
const PS_SCALE = 1.15;
const ps = (n) => Math.round(n * PS_SCALE * 100) / 100;

const PS = {
  bizName:    13,    // "ASWIN CLOUD LABS" fits to 14pt
  bizMeta:     8,    // address / phone / email / GSTIN — wraps past 8
  docType:    10,    // "TAX INVOICE"
  meta:        9,    // No. / Date / Status — "No." + a long invoice no. caps at 13.5
  label:       8,    // "BILL TO" / "PAY TO"
  client:      9.5,
  clientMeta:  8,
  itemDesc:   10,
  itemCalc:    8.5,  // "  10 x 2,500.00" + amount; shrinks to fit
  totals:      9,    // Subtotal / Discount / Shipping / tax rows
  grandLabel: 10,    // "TOTAL (Rs.)" on its own line
  grand:      18,    // the headline figure, alone on its line; shrinks if huge
  prose:       8,    // pay-to, notes
  // The gift-card code is read off the paper and typed into Amazon, so it is the
  // largest thing in its block. 11.3 scales to 13pt, and 45mm holds a 16-char
  // code at 13.3pt — so this is the ceiling for a typical code, with fit:true
  // catching a longer one.
  giftCode:   11.3,
  footer:      7.5,
};
for(const k in PS) if(k !== "footer") PS[k] = ps(PS[k]);

// jsPDF's core fonts are WinAnsi-encoded and have no ₹ — it silently prints as
// "¹". "Rs." is the conventional spelling on Indian thermal receipts anyway.
// £/€/$ all survive WinAnsi, so they pass through untouched.
const posCur = (cur) => cur === "₹" ? "Rs." : cur;

// Receipt-local money formatter: mirrors fmt() but with the PDF-safe symbol,
// and never depends on the live #currency element mid-render.
function posMoney(n, cur, withSym){
  const loc = cur === "₹" ? "en-IN" : "en-US";
  const s = Number(n||0).toLocaleString(loc, {minimumFractionDigits:2, maximumFractionDigits:2});
  const sym = posCur(cur);
  return withSym && sym ? sym + " " + s : s;
}

// Split a textarea's value into the lines the user actually typed. Blank lines
// are dropped (they'd feed empty paper on a roll) but real breaks are kept, so
// a formatted block reaches the receipt as written.
const lines = (s) => String(s || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// Collect every line the receipt will draw, as {t:type, ...} ops. Building the
// op list before touching jsPDF is what lets us measure the height up front.
function posOps(){
  const v = (id) => $(id).value.trim();
  const items = readItems().filter(i => i.desc || i.amt);
  const t = computeTotals(items);
  const cur = $("currency").value;
  const ops = [];
  const money = (n) => posMoney(n, cur, false);

  // The mark, above the name. Both, not either: at 22mm of 1-bit dots a logo
  // is recognition, and the name in caps is the thing that is actually legible.
  const rlogo = receiptLogoUrl();
  if(rlogo) ops.push({t:"sign", url:rlogo, w:LOGO_MM, ratio:_logoCache.ratio});
  ops.push({t:"center", s:(v("bizName") || "Your Business").toUpperCase(), bold:true, size:PS.bizName});
  lines(v("bizAddr")).forEach(l => ops.push({t:"center", s:l, size:PS.bizMeta}));
  // Phone and email each get their own line. Joined with " · " they overflow
  // 53mm and wrap mid-separator, leaving a dangling "·" on the next line.
  if(v("bizPhone")) ops.push({t:"center", s:v("bizPhone"), size:PS.bizMeta});
  if(v("bizEmail")) ops.push({t:"center", s:v("bizEmail"), size:PS.bizMeta});
  if(v("bizGst")) ops.push({t:"center", s:"GSTIN: "+v("bizGst"), size:PS.bizMeta});
  // Bare, no label: "Udyam: UDYAM-PY-03-0060956" is 26 characters and wrapped
  // to two lines on the 48mm head. The number is self-identifying.
  if(v("bizUdyam")) ops.push({t:"center", s:v("bizUdyam"), size:PS.bizMeta, fit:true});

  ops.push({t:"rule"});
  ops.push({t:"center", s:docTitle(), bold:true, size:PS.docType, track:true});
  ops.push({t:"rule"});

  if(v("invNo"))     ops.push({t:"kv", k:"No.",    val:v("invNo")});
  if(v("issueDate")) ops.push({t:"kv", k:"Date",   val:fmtDate(v("issueDate"))});
  if(v("dueDate"))   ops.push({t:"kv", k:"Due",    val:fmtDate(v("dueDate"))});
  ops.push({t:"kv", k:"Status", val:v("status") || "UNPAID"});

  if(v("clName") || v("clAddr") || v("clGst")){
    ops.push({t:"rule"});
    ops.push({t:"left", s:"BILL TO", size:PS.label, bold:true});
    if(v("clName")) ops.push({t:"wrap", s:v("clName"), size:PS.client});
    lines(v("clAddr")).forEach(l => ops.push({t:"wrap", s:l, size:PS.clientMeta}));
    if(v("clGst"))  ops.push({t:"wrap", s:"GSTIN: "+v("clGst"), size:PS.clientMeta});
  }

  ops.push({t:"rule"});
  if(!items.length){
    ops.push({t:"center", s:"(no line items)", size:PS.itemDesc});
  } else {
    // Description on its own line, then "qty x rate" indented with the amount
    // right-aligned — 48mm can't hold a 4-column table without truncating.
    // fit:true keeps "qty x rate" and the amount on one line: a big quantity
    // against a big rate otherwise wraps mid-expression ("12345.67 x" / "8,888.88").
    items.forEach(i => {
      ops.push({t:"wrap", s:i.desc || "Item", size:PS.itemDesc});
      ops.push({t:"kv", k:`  ${trimNum(i.qty)} x ${money(i.rate)}`, val:money(i.amt), size:PS.itemCalc, fit:true});
    });
  }
  ops.push({t:"rule"});

  // fit:true throughout — a wrapped money label reads as two rows and breaks
  // the column ("Shipping (Hand" / "delivery)"). Shrinking the row a quarter
  // point keeps one label against one figure, which is what a receipt needs.
  // Directly under the items it counts, above the money.
  const units = itemUnits(items);
  if(units){
    ops.push({t:"kv", k:"Items", val:fmtUnits(units), size:PS.totals, fit:true});
    ops.push({t:"gap", h:1});
  }
  ops.push({t:"kv", k:"Subtotal", val:money(t.subtotal), size:PS.totals, fit:true});
  if(t.disc)     ops.push({t:"kv", k:`Discount (${trimNum(num($("discount").value))}%)`, val:"-"+money(t.disc), size:PS.totals, fit:true});
  if(t.shipping) ops.push({t:"kv", k:"Shipping"+(shipMode()?` (${shipMode()})`:""), val:money(t.shipping), size:PS.totals, fit:true});
  // How it went out, when it cost nothing to send.
  //
  // The mode used to be only a parenthetical on the shipping CHARGE, so typing
  // "Rapido" and leaving the charge at zero printed nothing at all — the row it
  // was attached to never rendered. Delivery is a fact about the order whether
  // or not it was billed for, and on a counter receipt it is often the only
  // record of how the customer is getting their goods.
  else if(shipMode()) ops.push({t:"kv", k:"Delivery", val:shipMode(), size:PS.totals, fit:true});
  if(t.packaging) ops.push({t:"kv", k:pkgLabel(), val:money(t.packaging), size:PS.totals, fit:true});
  // Only when a tax actually follows it: "Taxable" names the base a tax was
  // computed on, so on a no-tax invoice it is a number with no meaning. The
  // email and the PDF already had this condition; the receipt did not.
  if((t.disc || t.shipping || t.packaging) && t.taxRows.length)
    ops.push({t:"kv", k:"Taxable", val:money(t.taxable), size:PS.totals, fit:true});
  t.taxRows.forEach(([l,val]) => ops.push({t:"kv", k:l, val:money(val), size:PS.totals, fit:true}));
  if(showRound(t))
    ops.push({t:"kv", k:"Round off", val:(t.round<0?"-":"+")+money(Math.abs(t.round)), size:PS.totals, fit:true});

  ops.push({t:"rule", heavy:true});
  // The label and the figure each get their own line, the way a till receipt
  // prints it. Sharing one line is what kept this small: "TOTAL (Rs.)" plus a
  // 9-character figure cannot exceed 10.75pt inside 48mm, however large a size
  // we ask for. Alone, the figure fits at 18pt — and it's the number the
  // customer actually looks for, so it gets the space.
  ops.push({t:"left",   s:"TOTAL"+(cur?` (${posCur(cur)})`:""), size:PS.grandLabel, bold:true});
  ops.push({t:"right",  s:money(t.total), size:PS.grand, bold:true, fit:true});
  ops.push({t:"rule", heavy:true});

  // The figure written out, as the A4 carries it. It is the check against a
  // total being altered after the fact, and ~4mm of paper is a fair price for
  // the one line on a receipt that cannot be quietly changed.
  const words = amountInWords(t.total, cur);
  if(words){
    ops.push({t:"wrap", s:words, size:PS.prose});
    ops.push({t:"gap", h:1});
  }

  // One op per typed line, so a line break survives onto the paper. These used
  // to be joined with " · " and " ", which turned a deliberately formatted
  // block ("A/C 1234…" then "IFSC …") into one run-on line. The preview honours
  // the breaks via white-space:pre-line, so the receipt should too.
  // On a settled receipt this is the Razorpay reference, not the UPI id — the
  // customer has already paid, and printing payment instructions on their copy
  // is how a duplicate payment happens. See payBlock().
  // Print the marker whenever the invoice is settled, even with no reference
  // lines beneath it. Only an online payment has a Razorpay ref; one settled by
  // hand — cash or a UPI transfer at the counter — has nothing to print under
  // the heading, and gating on lines.length dropped the whole block. The
  // customer's copy then said nothing about payment at all: no PAID, and no
  // pay-to either, since a paid invoice correctly suppresses that.
  const payNow = payBlock();
  if(payNow.paid || payNow.lines.length){
    ops.push({t:"left", s:payNow.label.toUpperCase(), size:PS.label, bold:true});
    payNow.lines.forEach(l => ops.push({t:"wrap", s:l, size:PS.prose}));
  }
  if(v("notes")){
    ops.push({t:"gap", h:1});
    lines(v("notes")).forEach(l => ops.push({t:"wrap", s:l, size:PS.prose}));
  }
  // The signature, above the QR and the thank-you: it closes the record of the
  // sale, and the advert comes after it.
  const signUrl = signDataUrl();
  if(signUrl){
    ops.push({t:"gap", h:1.5});
    ops.push({t:"sign", url:signUrl, w:SIGN_MM});
    ops.push({t:"center", s:"Authorised Signatory", size:PS.footer});
  }

  // "Scan to pay" first, because on an unpaid receipt it is the actionable one
  // and the order QR below it is an advert. Two codes on one strip make the
  // captions load-bearing: unlabelled, it is a coin flip which one gets scanned.
  const payQr = payQrRows();
  if(payQr){
    ops.push({t:"gap", h:2});
    ops.push({t:"qr", rows:payQr});
    ops.push({t:"center", s:"Scan to pay by UPI", size:PS.footer});
    // The payee the QR ACTUALLY encodes, read back out of the payload — not the
    // UPI ID box, which a pasted provider QR overrides. Printing one while the
    // code points at the other would be the worst kind of wrong.
    const payee = payeeFromPayQr();
    // fit:true, because a provider VPA is long: "merchant123456.rzp@exbank"
    // is 29 characters, which is 46mm at 7.5pt Courier against 45mm of content,
    // and wrapping it put a lone "l" on its own line under the QR. Shrinking to
    // one line reads as an address; broken across two reads as a mistake.
    if(payee) ops.push({t:"center", s:payee, size:PS.footer, fit:true});
  }

  // "Scan for other products and order online" — last, because it is an advert
  // and everything above it is the record of the sale. Only for a business that
  // has a shop link; the modules come from the server (see src/qr.js), so a
  // business without one adds nothing to the receipt at all.
  const qr = activeQrRows();
  if(qr){
    ops.push({t:"gap", h:2});
    ops.push({t:"qr", rows:qr});
    const cap = (BIZ_QR_CAPTION || "").trim() || "Scan for more products & order online";
    ops.push({t:"center", s:cap, size:PS.footer});
  }

  // The gift card, last of all: it is what the customer takes away, and it
  // belongs after the record of the sale rather than inside it.
  const gift = giftOnInvoice();
  if(gift){
    ops.push({t:"gap", h:1.5});
    ops.push({t:"rule"});
    /* Every line here is short enough to fit 45mm at its own size, because the
       first draft wrapped twice and looked like a mistake rather than a present:
       "A LITTLE SOMETHING FOR / YOU" and "Redeem at amazon.in - Gift / cards".
       At 9.2pt Courier, 45mm holds about 24 characters. */
    /* Sized line by line against the 45mm strip, largest where it matters.
       At 11.5pt Courier 45mm holds 15 characters, so "Amazon Pay Gift Card" —
       20 — sits a step down at PS.totals; everything else was measured to fit
       outright rather than left to wrap. */
    const cur = $("currency").value;
    ops.push({t:"center", s:"A GIFT FOR YOU", size:PS.docType, bold:true});
    ops.push({t:"center", s:gift.label, size:PS.totals, fit:true});
    // A range, not the figure: the card is a surprise, and the exact value is
    // kept on the invoice for the records rather than printed here.
    ops.push({t:"center", s:"A random amount", size:PS.itemDesc});
    // Whole rupees: ".00" twice on a range is noise, and it cost enough width
    // to make fit:true shrink the line below the size it was chosen at.
    const sym = posCur(cur);
    const amt = (n) => (sym ? sym + " " : "") + n;
    ops.push({t:"center", s:`${amt(GIFT_MIN)} to ${amt(GIFT_MAX)}`,
              size:PS.itemDesc, fit:true});
    // The biggest thing in the block: it gets typed into Amazon off this paper.
    ops.push({t:"center", s:gift.code, size:PS.giftCode, bold:true, fit:true});
    ops.push({t:"center", s:"Redeem at amazon.in", size:PS.clientMeta});
    ops.push({t:"center", s:"Not part of this bill", size:PS.clientMeta});
  }

  ops.push({t:"gap", h:1.5});
  // The stock thank-you is a nicety, not a fixture — skip it when the notes
  // already say it, rather than printing the same sentence twice.
  if(!/thank you/i.test(v("notes")))
    ops.push({t:"center", s:"Thank you for your business!", size:PS.footer});
  // The business's own line, not ours — this goes to their customer, and every
  // millimetre of a 57mm roll is paper. GSTIN over our branding.
  if(v("bizGst")) ops.push({t:"center", s:"GSTIN " + v("bizGst"), size:PS.footer});
  return ops;
}

// 10 -> "10", 2.5 -> "2.5": quantities shouldn't gain trailing zeros on a
// receipt where every character costs width.
const trimNum = (n) => String(Math.round(Number(n||0)*100)/100);

// Draw the ops with a given jsPDF doc. Returns the y it finished at, so the
// same routine both measures (throwaway doc) and renders (real doc).
function posDraw(doc, ops){
  // Both bounds are the head's, not the page's: the page is the full 57mm of
  // paper, but only 4..54mm of it can take ink. Using POS_W as the right edge
  // would place amounts 3mm beyond where the head stops.
  const L = POS_L, R = POS_R;
  let y = 4;
  const lh = (size) => size * 0.42;   // pt -> mm leading, tuned for Courier

  // The size of the last text drawn, so a rule can clear its descenders.
  let lastSize = PS.meta;

  for(const op of ops){
    if(op.t === "gap"){ y += op.h; continue; }
    if(op.t === "rule"){
      /* Clear the previous line's DESCENDERS, not just its baseline.

         y sits on the baseline of the text above, and 1.2mm of fixed gap was
         measured against 8pt type. At 9.2pt a descender reaches ~0.7mm below
         the baseline, leaving 0.5mm — four dots — and on paper that closed:
         "Pondicherry" printed with the bottom of its y clipped by the rule
         under BILL TO. Four dots is inside the slack of a paper feed.

         Scaling with the text above keeps the clearance honest at any PS_SCALE,
         which a fixed number stops doing the moment the type changes size. The
         floor keeps the old spacing for rules that follow nothing. */
      // Capped: the rule under the grand total follows 20.7pt digits, which have
      // no descenders at all, and an uncapped formula spent 3.9mm clearing
      // nothing. 2mm covers the deepest descender any size here produces.
      y += Math.min(2.0, Math.max(1.2, lastSize * 0.42 * 0.45));
      doc.setLineWidth(op.heavy ? 0.4 : 0.15);
      doc.line(L, y, R, y);
      y += 1.8;
      continue;
    }
    let size = op.size || PS.meta;
    lastSize = size;
    doc.setFont("courier", op.bold ? "bold" : "normal");
    doc.setFontSize(size);

    // Shrink-to-fit for lines flagged fit:true. Step down until the line fits.
    // The floor is a fraction of the row's own size rather than a fixed value:
    // a shared floor at PS.totals would leave the totals rows (which start
    // there) unable to shrink at all, and a long shipping mode would wrap
    // instead. 0.75 is enough for every label the form can produce while
    // keeping a row recognisably the same size as its neighbours.
    if(op.fit){
      const full = size;
      const floor = size * 0.75;
      const width = () => op.t === "kv"
        ? doc.getTextWidth(op.k) + doc.getTextWidth(op.val) + 1.5
        : doc.getTextWidth(op.s);
      while(size > floor && width() > POS_CONTENT){
        size -= 0.25;
        doc.setFontSize(size);
      }
      // Shrinking is only worth it if it BUYS the single line. A key so long
      // that it still cannot share a line with its value at the floor is going
      // to wrap below regardless - and a wrapped label at three-quarter size is
      // the worst of both: "Secure 3-layer packaging" came out small AND on two
      // lines. If it must wrap, wrap at full size.
      if(op.t === "kv" && width() > POS_CONTENT){
        size = full;
        doc.setFontSize(size);
      }
    }

    if(op.t === "kv"){
      // Key left, value hard right. If the key is too long to leave room for
      // the value, wrap the key and put the value on the last line's right.
      const valW = doc.getTextWidth(op.val);
      const keyMax = POS_CONTENT - valW - 1.5;
      const keyLines = doc.splitTextToSize(op.k, Math.max(keyMax, 10));
      keyLines.forEach((line, idx) => {
        y += lh(size);
        doc.text(line, L, y);
        if(idx === keyLines.length - 1) doc.text(op.val, R, y, {align:"right"});
      });
      continue;
    }
    if(op.t === "sign"){
      // A raster, unlike the QR — a signature is not a grid of squares. jsPDF
      // embeds it and pdftoppm resamples it on the way to the head; measured
      // through that exact pipeline it stays legible down to 30mm, and 36mm is
      // what was chosen. Width is a whole number of dots for the same reason
      // QR_DOTS is.
      const w = op.w;
      const h = w * (op.ratio || SIGN_RATIO || 0.42);
      y += 1.2;
      doc.addImage(op.url, "PNG", (L + R) / 2 - w / 2, y, w, h, undefined, "FAST");
      y += h;
      continue;
    }
    if(op.t === "qr"){
      // Drawn as filled squares, not an image: jsPDF's addImage would raster a
      // PNG that pdftoppm then re-samples on the way to the print head, and two
      // resamplings of a 1-bit pattern is how a QR stops scanning. Rectangles
      // survive both steps.
      //
      // The module size is chosen in PRINTER DOTS, not millimetres. The head is
      // 8 dots/mm and the pipeline thresholds at 176 without dithering, so a
      // module of 3.5 dots lands half on and half off a dot column and comes out
      // ragged. QR_DOTS is a whole number for that reason — see the note there.
      const n = op.rows.length;

      /* Step the module size down until the code fits the printable strip.
      
         QR_DOTS suits the codes this app generates — 29 modules for a shop URL,
         33 for a plain UPI URI. But a pasted provider QR can be much denser: the
         real Razorpay static QR is 45 modules, which is 39.75mm at 6 dots
         against 45mm of content, and an EMV payload can reach 57+ modules, which
         at 6 dots would be 48.75mm and print off the edge of the head.
      
         Clipped finder patterns do not scan, so a code that does not fit is
         drawn smaller rather than drawn wrong. 4 dots is the floor established
         when this was first sized; below it the modules alias at this threshold
         and no phone reads them, so an oversized code is skipped entirely — no
         QR is honest, half a QR is not. */
      let dots = QR_DOTS;
      const width = (d) => (n + QR_QUIET_MODULES * 2) * d / DOTS_PER_MM;
      while(dots > 4 && width(dots) > POS_CONTENT) dots--;
      if(width(dots) > POS_CONTENT){
        console.warn(`pay/order QR is ${n} modules — too dense for a 57mm roll, skipped`);
        continue;
      }

      const mod = dots / DOTS_PER_MM;                  // mm per module
      const span = (n + QR_QUIET_MODULES * 2) * mod;
      const x0 = (L + R) / 2 - span / 2;               // centred in the ink window
      y += 1.2;

      doc.setFillColor(0, 0, 0);
      for(let r = 0; r < n; r++){
        const row = op.rows[r];
        let c = 0;
        while(c < n){
          if(row.charAt(c) !== "1"){ c++; continue; }
          // Merge a run of dark modules into one rectangle: fewer, larger fills
          // rasterise more predictably than hundreds of abutting 0.5mm squares,
          // which can leave hairline seams the threshold turns white.
          let run = 1;
          while(c + run < n && row.charAt(c + run) === "1") run++;
          doc.rect(x0 + (c + QR_QUIET_MODULES) * mod,
                   y + (r + QR_QUIET_MODULES) * mod,
                   run * mod, mod, "F");
          c += run;
        }
      }
      y += span;
      continue;
    }
    // center / right / left / wrap all wrap at the content width. Centring is
    // on the midpoint of the head's window (L..R = 29mm), not the page's
    // (28.5mm) — the window isn't centred on the paper, so using POS_W/2 would
    // sit centred lines half a millimetre left of the body text.
    const mid = (L + R) / 2;
    const lines = doc.splitTextToSize(op.s, POS_CONTENT);
    lines.forEach(line => {
      y += lh(size);
      if(op.t === "center")     doc.text(line, mid, y, {align:"center"});
      else if(op.t === "right") doc.text(line, R, y, {align:"right"});
      else                      doc.text(line, L, y);
    });
  }
  return y;
}

// Build the receipt. Two passes: measure on a scratch doc, then draw on a page
// cut to that exact height (+ bottom padding for the tear-off).
async function renderPosReceipt(){
  await ensurePdfLibs();
  const { jsPDF } = window.jspdf;
  const ops = posOps();
  const probe = new jsPDF({unit:"mm", format:[POS_W, 600]});
  const h = posDraw(probe, ops) + 6;
  // The floor must exceed POS_W: jsPDF silently switches to landscape when
  // height < width, which would rotate the receipt 90°. No real receipt is
  // short enough to hit it, but the floor used to sit above the page width
  // and now doesn't, so make the dependency explicit rather than incidental.
  const doc = new jsPDF({unit:"mm", format:[POS_W, Math.max(h, POS_W + 20)]});
  posDraw(doc, ops);
  return doc;
}

// Save the receipt to disk. Reached only by the Download button — printing no
// longer falls back to this, because a download nobody asked for reads as
// success when the paper never came out.
function savePosReceipt(doc){
  const no = ($("invNo").value.trim() || "receipt").replace(/[^\w.-]+/g, "-");
  // Named for the paper it's meant for, not the page width — someone
  // looking for "the 57mm receipt" shouldn't have to know it prints 52.
  doc.save(`receipt-${no}-57mm-roll.pdf`);
}

/* Build the receipt, reporting a failure on the button that was pressed.
   Returns null if it couldn't be built, having already told the user. */
async function buildPosReceipt(){
  try {
    return await renderPosReceipt();
  } catch(e) {
    console.warn("POS receipt failed:", e);
    alert("Couldn't build the receipt: " + (e.message || e));
    return null;
  }
}

/* Run `job` with the button disabled and showing `busy`, restoring it after.
   Shared by the two receipt buttons so neither can be double-fired mid-job. */
async function withBusy(btn, busy, job){
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = busy;
  try { await job(ok => { btn.textContent = ok; setTimeout(() => { btn.textContent = was; }, 2500); }); }
  finally {
    btn.disabled = false;
    if(btn.textContent === busy) btn.textContent = was;
  }
}

// "POS receipt" — always downloads, signed in or not. Kept separate from the
// printer so there's still a way to get the PDF when the printer is the thing
// that's broken.
async function downloadPosReceipt(){
  await withBusy($("btnPos"), "…", async () => {
    const doc = await buildPosReceipt();
    if(doc) savePosReceipt(doc);
  });
}

/* "Print" — send the receipt to the thermal printer at the office.

   The PDF goes to the server, which forwards it to the printer; the button
   waits for the paper to actually come out, so "Printed" means printed rather
   than "queued somewhere".

   A failure is reported and nothing else happens — see the catch below for why
   it does not quietly hand over a PDF instead. */
async function printPosReceipt(){
  await withBusy($("btnPosPrint"), "Printing…", async (done) => {
    const doc = await buildPosReceipt();
    if(!doc) return;
    try {
      const uri = doc.output("datauristring");
      await api("/print", {method:"POST",
        body: JSON.stringify({pdfBase64: uri.slice(uri.indexOf(",") + 1)})});
      done("Printed ✓");
    } catch(e) {
      // Report the failure and stop. This used to also download the PDF, but a
      // silent download is the wrong answer at a counter: the receipt did not
      // print, and quietly producing a file in the browser's downloads folder
      // reads as partial success while the customer is still waiting. Say it
      // failed, plainly; the Download button is right there if a file is wanted.
      console.warn("print failed:", e);
      alert("Couldn't print the receipt.\n\n" + (e.message || e) +
            "\n\nNothing was printed. Try again, or use Download for a PDF.");
    }
  });
}

