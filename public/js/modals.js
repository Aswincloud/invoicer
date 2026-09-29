/* modals.js — the Settings modal and the My Invoices dashboard.
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
/* ── settings / per-user invoice defaults ──────────────────────── */
const SET_FIELDS = {  // modal field id -> defaults key
  setCurrency:"currency", setPrefix:"prefix", setTaxMode:"taxMode",
  setTaxRate:"taxRate", setDiscount:"discount", setDueDays:"dueDays", setNotes:"notes",
  setPackaging:"packaging", setPackagingLabel:"packagingLabel",
};
const SET_BIZ = { setBizName:"bizName", setBizEmail:"bizEmail", setBizAddr:"bizAddr",
  setBizPhone:"bizPhone", setBizGst:"bizGst", setBizUdyam:"bizUdyam", setBizPay:"bizPay",
  setQrUrl:"qrUrl", setQrCaption:"qrCaption", setUpiVpa:"upiVpa", setPayQr:"payQr" };

// Apply saved defaults to a fresh invoice. Only fills fields the user left at
// their generic default, so it never clobbers something already typed.
function applyDefaults(d){
  if(!d) return;
  if(d.currency) $("currency").value = d.currency;
  if(d.taxMode)  $("taxMode").value  = d.taxMode;
  if(d.taxRate!=="" && d.taxRate!=null) $("taxRate").value = d.taxRate;
  if(d.discount!=="" && d.discount!=null) $("discount").value = d.discount;
  if(d.packaging!=="" && d.packaging!=null) $("packaging").value = d.packaging;
  if(d.packagingLabel!=null && d.packagingLabel!=="") $("packagingLabel").value = d.packagingLabel;
  if(d.notes && !$("notes").value) $("notes").value = d.notes;
  if(d.dueDays!=="" && d.dueDays!=null){
    const n=parseInt(d.dueDays,10); if(Number.isFinite(n)) $("dueDate").value = todayISO(n);
  }
  if(d.prefix && !CURRENT_ID){
    // Rewrite the auto number to carry the user's prefix — but never while an
    // existing invoice is open: renumbering a saved document loses it.
    freshInvoiceNumber().then(nu => { if(!CURRENT_ID) { $("invNo").value = nu; render(); } });
  }
  render();
}

function openSettings(){
  if(!ME) return;
  $("setMsg").textContent=""; $("setMsg").className="msg";
  // The business currently filling the form. saveSettings writes to that one,
  // so reading the account default here would show one business's details and
  // save them over another's.
  const active = activeBiz();
  const b = (active && active.biz) || ME.biz || {};
  const d = (active && active.defaults) || ME.defaults || {};
  for(const [id,k] of Object.entries(SET_BIZ)) $(id).value = b[k]||"";
  for(const [id,k] of Object.entries(SET_FIELDS)) $(id).value = (d[k]!=null?d[k]:"");
  syncLogoUI(); syncSignUI();   // current logo + signature in the modal
  $("setModal").hidden=false;
}
function closeSettings(){ $("setModal").hidden=true; }

async function saveSettings(){
  const msg=$("setMsg"); msg.className="msg"; msg.textContent="Saving…";
  const biz={}; for(const [id,k] of Object.entries(SET_BIZ)) biz[k]=$(id).value;
  biz.bizLogo = BIZ_LOGO;
  biz.bizSign = BIZ_SIGN;
  const defaults={}; for(const [id,k] of Object.entries(SET_FIELDS)) defaults[k]=$(id).value;
  try{
    // businessId, or this edits whichever business is DEFAULT rather than the
    // one currently filling the form. Fields this modal does not know about —
    // the shop link, the QR caption, the signature — are simply absent, and
    // the server now leaves absent fields alone instead of blanking them.
    await api("/profile",{method:"PUT",
      body:JSON.stringify({...biz, businessId: ACTIVE_BIZ, defaults})});
    ME.biz={...ME.biz,...biz}; ME.defaults=defaults;
    // reflect business fields into the live form + localStorage immediately
    BIZ_FIELDS.forEach(f=>{ if(biz[f]!=null) $(f).value=biz[f]; });
    if(biz.qrUrl!=null) $("bizQrUrl").value = biz.qrUrl;
    if(biz.qrCaption!=null) $("bizQrCaption").value = biz.qrCaption;
    if(biz.upiVpa!=null) $("bizUpiVpa").value = biz.upiVpa;
    if(biz.payQr!=null) $("bizPayQr").value = biz.payQr;
    saveBiz();
    // The QR is encoded server-side, so a shop link changed here only becomes
    // printable once it has been saved and read back.
    await refreshBusinesses();
    render();
    msg.className="msg ok"; msg.textContent="Saved ✓";
    setTimeout(closeSettings, 700);
  }catch(e){ msg.className="msg err"; msg.textContent="Save failed: "+e.message; }
}

function wireSettings(){
  $("btnSettings").onclick = openSettings;
  $("setClose").onclick = closeSettings;
  $("setModal").onclick = (e)=>{ if(e.target===$("setModal")) closeSettings(); };
  $("setSave").onclick = saveSettings;
}
document.addEventListener("DOMContentLoaded", wireSettings);

/* ── My Invoices dashboard ─────────────────────────────────────── */
function invAmt(cur, total){
  const n = Number(total)||0;
  const loc = cur === "₹" ? "en-IN" : "en-US";
  return (cur ? cur+" " : "") + n.toLocaleString(loc, {minimumFractionDigits:2, maximumFractionDigits:2});
}
function invDate(s){ return s || "—"; }

async function openInvoices(){
  if(!ME) return;
  const box = $("invList");
  box.innerHTML = `<div class="inv-loading">Loading…</div>`;
  $("invModal").hidden = false;
  try{
    const { invoices } = await api("/invoices");
    renderInvoiceList(invoices || []);
  }catch(e){
    box.innerHTML = `<div class="inv-empty">Couldn't load invoices: ${esc(e.message)}</div>`;
  }
}
function closeInvoices(){ $("invModal").hidden = true; }

function renderInvoiceList(list){
  const box = $("invList");
  if(!list.length){
    box.innerHTML = `<div class="inv-empty">No saved invoices yet.<br>Create one, then hit <b>Save</b>.</div>`;
    return;
  }
  box.innerHTML = "";
  list.forEach(inv => {
    const st = (inv.status||"").toUpperCase();
    const row = document.createElement("div");
    row.className = "inv-row";
    row.innerHTML =
      `<div class="inv-main">
         <div class="inv-num">${esc(inv.number||"(no number)")}</div>
         <div class="inv-sub">
           <span class="inv-who">${esc(inv.client_name||"—")} · ${esc(invDate(inv.issue_date))}</span>
           ${st?`<span class="inv-badge ${esc(st)}">${esc(st)}</span>`:""}</div>
       </div>
       <div class="inv-right">
         <span class="inv-amt">${esc(invAmt(inv.currency, inv.total))}</span>
         <div class="inv-acts">
           <button class="btn ghost open">Open</button>
           <button class="btn ghost link">Copy link</button>
           <button class="btn ghost email">Email</button>
           <button class="btn ghost del">Delete</button>
         </div>
       </div>`;
    row.querySelector(".open").onclick  = () => openInvoiceInEditor(inv.id);
    row.querySelector(".link").onclick  = (e) => copyPayLink(inv, e.currentTarget);
    row.querySelector(".email").onclick = () => emailSavedInvoice(inv);
    row.querySelector(".del").onclick   = () => deleteSavedInvoice(inv, row);
    box.appendChild(row);
  });
}

/* Copy the invoice's public pay link to the clipboard.

   The token is minted server-side on first use, so an invoice that is never
   shared never gets a link. Falls back to a prompt() when the clipboard is
   unavailable — it needs a secure context and permission, and losing the link
   entirely because of that would defeat the button. */
async function copyPayLink(inv, btn){
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try{
    const { url } = await api("/invoices/"+inv.id+"/share", { method:"POST" });
    try{
      await navigator.clipboard.writeText(url);
      btn.textContent = "Copied ✓";
    }catch(_){
      // Not an error worth alerting over — show them the link so they can copy
      // it by hand.
      prompt("Copy this pay link:", url);
      btn.textContent = was;
    }
  }catch(e){
    alert("Couldn't create the link: " + (e.message || e));
    btn.textContent = was;
  }finally{
    btn.disabled = false;
    setTimeout(() => { btn.textContent = was; }, 2000);
  }
}

// Load a saved invoice back into the editor form + preview.
async function openInvoiceInEditor(id){
  try{
    const { inv, items } = await api("/invoices/"+id);
    // client + invoice fields
    $("invNo").value    = inv.number || "";
    $("issueDate").value= inv.issue_date || "";
    $("dueDate").value  = inv.due_date || "";
    $("currency").value = inv.currency || "₹";
    // A saved invoice's tax mode is a decision already made — don't re-infer
    // over it, or reopening an old invoice could silently change its tax kind.
    $("taxMode").value  = inv.tax_mode || "gst";
    TOUCHED.add("taxMode");
    $("taxRate").value  = inv.tax_rate ?? "";
    $("discount").value = inv.discount_pct ?? "";
    $("shipping").value = inv.shipping ? String(inv.shipping) : "";
    setShippingMode(inv.shipping_mode || "");
    // The saved fee and its saved label — not the business default, which may
    // have changed since this invoice went out.
    $("packaging").value = inv.packaging ? String(inv.packaging) : "";
    $("packagingLabel").value = inv.packaging_label || "";
    // Restore the saved setting rather than the default: an invoice stored with
    // exact paise must not gain a round-off line just because it was reopened.
    $("roundOff").checked = !!inv.round_off;
    // Absent on rows from before the column existed: those were all printed
    // with the QR, so absent reads as on.
    $("payQrOn").checked = inv.show_pay_qr == null ? true : !!inv.show_pay_qr;
    // Clear the target and render directly (not update()): a saved invoice's
    // rates are settled figures, and auto-solve must never rewrite them.
    $("targetTotal").value = ""; $("solveMsg").textContent = "";
    $("taxModeAuto").textContent = "";
    $("status").value   = (inv.status || "UNPAID");
    // Not a form field — written by the Razorpay webhook, carried so the
    // preview and the thermal receipt can print it. Keyed to this invoice's
    // number so it cannot leak onto a different invoice (Save always inserts a
    // new row rather than updating this one).
    CURRENT_ID = inv.id || id;   // subsequent saves update this row
    PAY_REF = inv.rzp_payment_id || inv.paid_at
      ? { number: (inv.number || "").trim(), id: inv.rzp_payment_id || "", at: inv.paid_at || 0 }
      : null;
    $("notes").value    = inv.notes || "";
    $("clName").value   = inv.client_name || "";
    $("clEmail").value  = inv.client_email || "";
    // Stored as E.164 digits; shown with the plus so it reads as a number.
    $("clPhone").value  = inv.client_phone ? "+" + inv.client_phone : "";
    $("clAddr").value   = inv.client_addr || "";
    $("clGst").value    = inv.client_gst || "";
    $("giftCode").value = inv.gift_code || "";
    $("giftAmount").value = inv.gift_amount ? String(inv.gift_amount) : "";
    $("giftOn").checked = !!(inv.gift_code || "").trim();
    syncGift();
    // line items
    $("items").innerHTML = "";
    (items.length ? items : [{description:"",qty:1,rate:""}]).forEach(it =>
      addItem(it.description||"", String(it.qty ?? ""), it.rate!=null ? String(it.rate) : ""));
    render();
    closeInvoices();
    window.scrollTo({top:0, behavior:"smooth"});
  }catch(e){ alert("Couldn't open invoice: "+e.message); }
}

async function emailSavedInvoice(inv){
  const to = prompt("Send invoice "+(inv.number||"")+" to (client email):", inv.client_email||"");
  if(!to) return;
  try{
    // Load this invoice into the editor so the preview (and thus the attached
    // PDF) matches exactly what we're emailing, then render + attach.
    await openInvoiceInEditor(inv.id);
    const pdfBase64 = await tryRenderPdf();
    await api("/invoices/"+inv.id+"/email",{method:"POST",body:JSON.stringify({to, pdfBase64})});
    alert("Invoice emailed to "+to+" ✓"+(pdfBase64?" (PDF attached)":""));
  }catch(e){ alert("Email failed: "+e.message); }
}

async function deleteSavedInvoice(inv, row){
  if(!confirm("Delete invoice "+(inv.number||"")+"? This can't be undone.")) return;
  try{
    await api("/invoices/"+inv.id,{method:"DELETE"});
    row.remove();
    if(!$("invList").querySelector(".inv-row"))
      $("invList").innerHTML = `<div class="inv-empty">No saved invoices yet.</div>`;
  }catch(e){ alert("Delete failed: "+e.message); }
}

function wireInvoices(){
  $("btnInvoices").onclick = openInvoices;
  $("invClose").onclick = closeInvoices;
  $("invModal").onclick = (e)=>{ if(e.target===$("invModal")) closeInvoices(); };
}
document.addEventListener("DOMContentLoaded", wireInvoices);
