/* render.js — the on-screen invoice preview.
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// ── render preview ───────────────────────────────────────────────
function render(){
  const items = readItems();
  const t = computeTotals(items);
  const v = (id) => $(id).value.trim();
  const cur = $("currency").value;
  const status = v("status") || "UNPAID";
  { const w = $("upiRefWrap"); if(w) w.hidden = status.toUpperCase() !== "PAID"; }
  const payNow = payBlock();
  const words = amountInWords(t.total, cur);
  const units = itemUnits(items);
  const pos = placeOfSupplyFromGst(v("clGst"));
  const initial = (v("bizName")||"I").trim().charAt(0).toUpperCase();

  const rowsHtml = items.filter(i=>i.desc||i.amt).map(i =>
    `<tr><td>${esc(i.desc)}</td><td class="r">${i.qty||""}</td>`+
    // Zeros print as 0.00 rather than blank. A line that reached the invoice is
    // a real line, and a blank price reads as missing data when what it means
    // is free.
    `<td class="r">${plainNum(i.rate)}</td>`+
    `<td class="r">${fmt(i.amt)}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:#9ca3af;text-align:center;padding:20px">Add line items to see them here…</td></tr>`;

  const taxHtml = t.taxRows.map(([l,val]) =>
    `<tr><td>${esc(l)}</td><td class="r">${fmt(val)}</td></tr>`).join("");

  $("paper").innerHTML =
`<div class="ph">
  <div class="brand">
    ${BIZ_LOGO
      ? `<img class="plogo-img" src="${esc(BIZ_LOGO)}" alt="${esc(v("bizName")||"Logo")}">`
      : `<div class="plogo">${esc(initial)}</div>`}
    <h1>${esc(v("bizName")||"Your Business")}</h1>
    <p>${esc(v("bizAddr"))}</p>
    <p>${esc(v("bizPhone"))}${v("bizPhone")&&v("bizEmail")?" · ":""}${esc(v("bizEmail"))}</p>
    ${v("bizGst")?`<p>GSTIN: ${esc(v("bizGst"))}</p>`:""}
    ${v("bizUdyam")?`<p>Udyam Reg. No.: ${esc(v("bizUdyam"))}</p>`:""}
  </div>
  <div class="title">
    <h2>INVOICE</h2>
    <div class="meta">
      ${v("invNo")?`<div>No. <b>${esc(v("invNo"))}</b></div>`:""}
      ${v("issueDate")?`<div>Issued <b>${esc(fmtDate(v("issueDate")))}</b></div>`:""}
      ${v("dueDate")?`<div>Due <b>${esc(fmtDate(v("dueDate")))}</b></div>`:""}
      <div><span class="badge ${esc(status)}">● ${esc(status)}</span></div>
    </div>
  </div>
</div>

<div class="parties">
  <div>
    <div class="lbl">Billed To</div>
    <p class="nm">${esc(v("clName")||"Client")}</p>
    <p>${esc(v("clAddr"))}</p>
    ${v("clEmail")?`<p>${esc(v("clEmail"))}</p>`:""}
    ${v("clGst")?`<p>GSTIN: ${esc(v("clGst"))}</p>`:""}
    ${pos?`<p>Place of supply: ${esc(pos)}</p>`:""}
  </div>
  <div style="text-align:right">
    <div class="lbl${payNow.paid ? " paid" : ""}">${esc(payNow.label)}</div>
    ${payNow.lines.map(l => `<p>${esc(l)}</p>`).join("")}
  </div>
</div>

<table class="lines">
  <thead><tr><th style="width:48%">Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>

<div class="totbox"><table>
  ${units?`<tr><td>Items</td><td class="r">${esc(fmtUnits(units))}</td></tr>`:""}
  <tr><td>Subtotal</td><td class="r">${fmt(t.subtotal)}</td></tr>
  ${t.disc?`<tr><td>Discount (${num($("discount").value)}%)</td><td class="r">– ${fmt(t.disc)}</td></tr>`:""}
  ${t.shipping?`<tr><td>Shipping${shipMode()?` (${esc(shipMode())})`:""}</td><td class="r">${fmt(t.shipping)}</td></tr>`
    :shipMode()?`<tr><td>Delivery</td><td class="r">${esc(shipMode())}</td></tr>`:""}
  ${t.packaging?`<tr><td>${esc(pkgLabel())}</td><td class="r">${fmt(t.packaging)}</td></tr>`:""}
  ${(t.disc||t.shipping||t.packaging)&&t.taxRows.length?`<tr><td>Taxable value</td><td class="r">${fmt(t.taxable)}</td></tr>`:""}
  ${taxHtml}
  ${showRound(t)?`<tr><td>Round off</td><td class="r">${t.round<0?"– ":"+ "}${fmt(Math.abs(t.round))}</td></tr>`:""}
  <tr class="grand"><td>Total ${cur?`(${esc(cur)})`:""}</td><td class="r">${fmt(t.total)}</td></tr>
</table></div>

${words?`<div class="pwords"><div class="lbl">Amount in words</div><p>${esc(words)}</p></div>`:""}
${v("notes")?`<div class="pfoot"><div class="lbl">Notes / Terms</div><p>${esc(v("notes"))}</p></div>`:""}
${giftBlockHtml()}
${qrSvgBlock()}
<div class="psign">${signImgTag()}<div class="sigline"></div>For ${esc(v("bizName")||"Your Business")}<br>Authorised Signatory</div>
<div class="pnote">${esc([v("bizName"),v("bizPhone"),v("bizEmail")].filter(Boolean).join(" · "))}</div>`;
}

/* The gift card on the on-screen sheet.

   Present here for the same reason the signature is: emailInvoice sends the PDF
   the BROWSER rendered when it has one, and that PDF is a bitmap of this sheet,
   so anything missing here is missing from most emailed invoices. */
function giftBlockHtml(){
  const g = giftOnInvoice();
  if(!g) return "";
  return `<div class="pgift">
    <div class="lbl">A little something for you</div>
    <p class="pgift-h">${esc(g.label)} · a random amount from ${esc(String(GIFT_MIN))} to ${esc(String(GIFT_MAX))}</p>
    <p class="pgift-code">${esc(g.code)}</p>
    <p class="pgift-note">Redeem at amazon.in → Gift cards. Yours to keep — it is not part of this bill.</p>
  </div>`;
}

/* The signature on the on-screen sheet.

   Same reason the QR is drawn here rather than only server-side: emailInvoice
   sends the PDF the BROWSER rendered when it has one, and that PDF is a bitmap
   of this sheet. A signature present only in the server-side PDF would be
   missing from most emailed invoices. */
function signImgTag(){
  const url = signDataUrl();
  return url ? `<img class="psign-img" src="${esc(url)}" alt="">` : "";
}

/* The order QR on the on-screen sheet.

   Not decoration, and not optional: emailInvoice sends the A4 PDF the BROWSER
   rendered whenever it has one, and that PDF is a bitmap of this preview. A QR
   that appeared only in the server-side PDF would therefore be missing from
   most emailed invoices — the ones sent from a tab with the invoice open.

   Inline SVG rather than an <img>: no data-URL to build, no asynchronous decode
   to race html2canvas, and it stays crisp when that bitmap is taken at 2x.
   Adjacent dark modules merge into one <rect> for the same reason the PDFs do
   it — a few dozen rects instead of several hundred. */
function qrSvgBlock(){
  const rows = activeQrRows();
  if(!rows) return "";

  const n = rows.length, q = QR_QUIET_MODULES, span = n + q * 2;
  let rects = "";
  for(let r = 0; r < n; r++){
    const row = rows[r];
    let c = 0;
    while(c < n){
      if(row.charAt(c) !== "1"){ c++; continue; }
      let run = 1;
      while(c + run < n && row.charAt(c + run) === "1") run++;
      rects += `<rect x="${c+q}" y="${r+q}" width="${run}" height="1"/>`;
      c += run;
    }
  }
  const cap = fld("bizQrCaption") || "Scan for more products & order online";
  return `<div class="pqr">
    <svg viewBox="0 0 ${span} ${span}" width="96" height="96" shape-rendering="crispEdges"
         role="img" aria-label="Scan to order online">
      <rect width="${span}" height="${span}" fill="#fff"/><g fill="#000">${rects}</g></svg>
    <div class="pqr-txt"><div class="lbl">Order online</div><p>${esc(cap)}</p></div>
  </div>`;
}

