/* export.js — PDF and PNG downloads of the on-screen invoice.
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// ── PDF of the on-screen invoice (for email attachment) ──────────
// Libs are loaded on first use so the page stays light for everyone who never
// emails. If the CDN is unreachable or rendering fails, callers fall back to
// sending the email without the attachment.
const _scriptCache = {};
function loadScript(src){
  return _scriptCache[src] || (_scriptCache[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("Failed to load "+src));
    document.head.appendChild(s);
  }));
}
async function ensurePdfLibs(){
  if(!window.html2canvas)
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
  if(!(window.jspdf && window.jspdf.jsPDF))
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
}

// Rasterize #paper and lay it into an A4 PDF, slicing across pages if the
// invoice is tall. Returns base64 (no data-URL prefix). Throws on failure.
/* The on-screen sheet as a bitmap. One renderer for every export - the PDF
   attachment, the PDF download and the PNG download all start here, so they
   cannot disagree about what the invoice looks like. */
async function renderPaperCanvas(){
  await ensurePdfLibs();
  return html2canvas($("paper"),
    {scale:2, backgroundColor:"#ffffff", useCORS:true, logging:false});
}

/* The invoice number as a filename stem: "INV-AC-2026-3201", or "invoice". */
function invoiceFileStem(){
  return ($("invNo").value.trim() || "invoice").replace(/[^\w.-]+/g, "-");
}

/* Wrap the sheet bitmap in an A4 PDF, paginating if it runs long. */
function buildInvoicePdfDoc(canvas){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:"pt", format:"a4"});
  const margin = 32;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const imgW = pageW - margin*2;
  const imgH = canvas.height * imgW / canvas.width;
  // JPEG, not PNG: the invoice is white with text, so JPEG is ~10× smaller with
  // no visible loss — keeps the attachment well under the server's size cap.
  const img = canvas.toDataURL("image/jpeg", 0.92);
  const usable = pageH - margin*2;
  let position = 0, heightLeft = imgH;
  doc.addImage(img, "JPEG", margin, margin, imgW, imgH);
  heightLeft -= usable;
  while(heightLeft > 0){
    position -= usable;
    doc.addPage();
    doc.addImage(img, "JPEG", margin, margin + position, imgW, imgH);
    heightLeft -= usable;
  }
  return doc;
}

async function renderInvoicePdfBase64(){
  const doc = buildInvoicePdfDoc(await renderPaperCanvas());
  const uri = doc.output("datauristring");     // data:application/pdf;...,<base64>
  return uri.slice(uri.indexOf(",")+1);
}

/* ── download as a file ─────────────────────────────────────────────
   "Download PDF" used to call window.print(), which opens the browser's print
   dialog and leaves the user to find "Save as PDF" in it - and on a phone,
   often cannot. These save a real file, named after the invoice. Print stays
   available in the menu for anyone who does want the dialog. */
async function downloadInvoicePdf(){
  const doc = buildInvoicePdfDoc(await renderPaperCanvas());
  doc.save(`${invoiceFileStem()}.pdf`);
}
async function downloadInvoicePng(){
  const canvas = await renderPaperCanvas();
  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${invoiceFileStem()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* The split button's menu: caret toggles, any choice or an outside click or
   Escape closes. The main half is the common case and needs no menu. */
function wireDownloadMenu(){
  const menu = $("dlMenu"), caret = $("btnDownloadMore");
  const open = (on) => { menu.hidden = !on; caret.setAttribute("aria-expanded", String(on)); };
  const busy = async (fn) => {
    open(false);
    $("btnDownload").disabled = true;
    try{ await fn(); }
    catch(e){ alert("Couldn't produce the file: " + (e.message || e)); }
    finally{ $("btnDownload").disabled = false; }
  };
  $("btnDownload").onclick = () => busy(downloadInvoicePdf);
  caret.onclick = (e) => { e.stopPropagation(); open(menu.hidden); };
  $("dlPdf").onclick   = () => busy(downloadInvoicePdf);
  $("dlPng").onclick   = () => busy(downloadInvoicePng);
  $("dlPrint").onclick = () => { open(false); window.print(); };
  document.addEventListener("click", (e) => { if(!$("dlWrap").contains(e.target)) open(false); });
  document.addEventListener("keydown", (e) => { if(e.key === "Escape") open(false); });
}

// Soft-fail wrapper: returns base64 PDF, or "" if it couldn't be produced.
// Server treats an empty/omitted pdfBase64 as "no attachment".
async function tryRenderPdf(){
  try{ return await renderInvoicePdfBase64(); }
  catch(e){ console.warn("PDF render failed; sending without attachment:", e); return ""; }
}

