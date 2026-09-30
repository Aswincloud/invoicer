/* init.js — init(), theme, the api() helper, collect().
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// ── init ─────────────────────────────────────────────────────────
function todayISO(d=0){ const t=new Date(); t.setDate(t.getDate()+d); return t.toISOString().slice(0,10); }
function init(){
  loadBiz();
  wireSections();
  syncLogoUI();
  syncSignUI();
  syncReceiptLogoUI();
  syncVpaHint();
  syncBizHint();
  if(!$("issueDate").value) $("issueDate").value = todayISO(0);
  // Due date is optional — left blank by default. A user's Settings "due in
  // days" default (applyDefaults) will fill it if they've set one.
  if(!$("invNo").value)
    freshInvoiceNumber().then(nu => { if(!CURRENT_ID) { $("invNo").value = nu; render(); } });

  // One empty row to type into. Qty defaults to 1 (the common case); the
  // description and rate are left blank rather than seeded with a sample —
  // a pre-filled price is a figure you have to notice and clear, and on an
  // invoice that's the kind of thing that goes out by accident.
  addItem();

  ALL_FIELDS.forEach(f => $(f).addEventListener("input", update));
  $("shippingMode").addEventListener("change", () => { syncShippingMode(); update(); });
  syncShippingMode();

  // Inference: recompute when a source field changes, and stop touching a
  // field the moment the user sets it themselves.
  ["bizGst","clGst"].forEach(f =>
    $(f).addEventListener("input", () => { applyInference(); update(); }));
  $("taxMode").addEventListener("change", () => { TOUCHED.add("taxMode"); applyInference(); update(); });
  applyInference();

  $("targetTotal").addEventListener("input", update);
  $("autoSolve").addEventListener("change", () => {
    // Turning it off leaves the rates exactly as solved — the note would go
    // stale, so clear it and let the user take over.
    if(!$("autoSolve").checked) $("solveMsg").textContent = "";
    update();
  });
  // Rounding changes the total, so the solver has to re-aim at it.
  $("roundOff").addEventListener("change", update);
  $("payQrOn").addEventListener("change", update);
  $("upiRef").addEventListener("input", render);
  // Business fields persist locally always, and to the account (debounced) when
  // signed in — so a logged-in user's profile lives in the cloud DB, not just
  // this device.
  [...BIZ_FIELDS, ...BIZ_QR_FIELDS].forEach(f =>
    $(f).addEventListener("input", () => {
      saveBiz(); persistProfileDebounced(); syncVpaHint(); syncBizHint(); render(); }));
  $("btnAddItem").onclick = () => { addItem(); update(); };
  wireDownloadMenu();
  $("btnPos").onclick = downloadPosReceipt;
  $("btnPosPrint").onclick = printPosReceipt;
  $("giftOn").onchange = () => { syncGift(); render(); };
  ["giftCode","giftAmount"].forEach(f =>
    $(f).addEventListener("input", render));
  syncGift();
  $("bizPicker").onchange = (e) => applyBiz(e.target.value);
  $("bizNew").onclick      = createBizProfile;
  $("bizDelete").onclick   = deleteBizProfile;
  $("btnReset").onclick = () => {
    if(!confirm("Start a new blank invoice? (Your saved business details are kept.)")) return;
    ["clName","clEmail","clPhone","clAddr","clGst","notes","shipping","shippingMode",
     "targetTotal","giftCode","giftAmount"].forEach(f=>$(f).value="");
    $("giftOn").checked = false; syncGift();
    syncShippingMode();
    // Packaging carries a business default, so a fresh invoice gets the default
    // back rather than a blank — the same way discount survives a reset.
    { const d = (activeBiz() || {}).defaults || {};
      $("packaging").value = (d.packaging != null && d.packaging !== "") ? d.packaging : "";
      $("packagingLabel").value = d.packagingLabel || ""; }
    $("solveMsg").textContent = "";
    $("autoSolve").checked = true;   // back to the default
    $("roundOff").checked = true;
    $("payQrOn").checked = true;   // the default: an unpaid bill invites payment
    TOUCHED.delete("taxMode");   // fresh invoice — infer again
    applyInference();
    $("status").value = "UNPAID";
    PAY_REF = null;              // a blank invoice carries no payment reference
    $("upiRef").value = ""; LOCKED_PAID = null;
    CURRENT_ID = null;           // ...and is not an edit of anything
    $("items").innerHTML=""; addItem();
    freshInvoiceNumber().then(nu => { $("invNo").value = nu; render(); });
    $("issueDate").value=todayISO(0); $("dueDate").value="";  // due date optional
    render();
  };
  render();
}
document.addEventListener("DOMContentLoaded", init);


/* ── theme (dark default, persisted) ───────────────────────────── */
const THEME_KEY = "invoicer.theme";
function applyTheme(t){ document.documentElement.setAttribute("data-theme", t);
  try{ localStorage.setItem(THEME_KEY, t); }catch(e){} }
(function initTheme(){
  let t="dark"; try{ t=localStorage.getItem(THEME_KEY)||"dark"; }catch(e){}
  applyTheme(t);
})();

/* ── backend integration (auth modal + save + email) ───────────── */
const api = (path, opts={}) =>
  fetch("/api"+path, {credentials:"same-origin",
    headers:{"content-type":"application/json"}, ...opts})
    .then(async r => { const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||r.status); return d; });

function collect(){
  const v=id=>$(id).value;
  return {number:v("invNo"),issueDate:v("issueDate"),dueDate:v("dueDate"),
    currency:v("currency"),taxMode:v("taxMode"),taxRate:v("taxRate"),
    discount:v("discount"),shipping:v("shipping"),shippingMode:shipMode(),
    packaging:v("packaging"),packagingLabel:$("packagingLabel").value.trim().slice(0,60),
    roundOff:$("roundOff").checked,
    showPayQr:$("payQrOn").checked,
    status:v("status"),notes:v("notes"),
    // Only meaningful on a PAID invoice; the server ignores it otherwise.
    upiRef:$("upiRef").value.trim(),
    // Which business is issuing it. Ignored by the server on an edit — the
    // issuing business is fixed at creation.
    businessId: ACTIVE_BIZ,
    clName:v("clName"),clEmail:v("clEmail"),clPhone:v("clPhone"),clAddr:v("clAddr"),clGst:v("clGst"),
    // A present, never a charge: these do not enter computeTotals on either
    // side of the wire. The checkbox is what decides whether it is sent at all,
    // so unticking it clears the card rather than hiding it.
    giftCode: $("giftOn").checked ? v("giftCode") : "",
    giftAmount: $("giftOn").checked ? (+$("giftAmount").value || 0) : 0,
    items:readItems().filter(i=>i.desc||i.amt).map(i=>({description:i.desc,qty:i.qty,rate:i.rate}))};
}

