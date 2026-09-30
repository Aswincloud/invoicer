/* backend.js — sign-in, the auth modal, save/email wiring (wireBackend).
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// brand SVGs (inline, currentColor where sensible)
const PROVIDER_SVG = {
  google:'<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-7.9z"/><path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M6 14.4a6.6 6.6 0 0 1 0-4.2V7.4H2.3a11 11 0 0 0 0 9.8L6 14.4z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.4L6 10.2c.9-2.6 3.2-4.8 6-4.8z"/></svg>',
  github:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2A10 10 0 0 0 8.8 21.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .8.1-.6.3-1.1.6-1.4-2.2-.300000000000004-4.5-1.1-4.5-5a4 4 0 0 1 1-2.7c-.1-.3-.5-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.4.2 2.4.1 2.7a4 4 0 0 1 1 2.7c0 3.9-2.3 4.7-4.5 5 .3.3.6.9.6 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
  microsoft:'<svg viewBox="0 0 24 24"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>',
};
const PROVIDER_LABEL = {google:"Continue with Google",github:"Continue with GitHub",microsoft:"Continue with Microsoft"};

let ME=null;
async function refreshMe(){
  try{ ME=(await api("/me")).user; }catch(e){ ME=null; }
  const on=!!ME;
  // Remember the identity we're signed in as (covers SSO too), so the login
  // modal can prefill it next time — independent of the business email.
  if(on && ME.email){ try{ localStorage.setItem(LOGIN_EMAIL_KEY, ME.email.toLowerCase()); }catch(_){} }
  $("who").textContent = on ? ME.email : "";
  $("btnAuth").textContent = on ? "Sign out" : "Sign in";
  $("btnSave").hidden = !on;
  // Sending is allow-listed per account on the server (src/access.js); the
  // button follows so a non-owner never sees an action that would 403.
  $("btnEmail").hidden = !(on && ME.features && ME.features.email);
  // Only when the server can actually send one - the button is gated on the
  // secrets being set, the same way printing is.
  $("waWrap").hidden = !(on && ME.features && ME.features.whatsapp);
  // Printing goes through the account (and an allowlist on the server), so the
  // button only makes sense signed in. "POS receipt" stays visible either way.
  $("btnPosPrint").hidden = !on;
  $("btnSettings").hidden = !on;
  $("btnInvoices").hidden = !on;
  syncBizHint();
  // The account's businesses replace whatever the device had cached. Signed out,
  // BIZ_LIST is empty and the form keeps working off localStorage exactly as it
  // did before any of this existed.
  BIZ_LIST = on ? (ME.businesses || []) : [];
  ACTIVE_BIZ = on ? (ME.defaultBusinessId || (BIZ_LIST[0] || {}).id || null) : null;
  renderBizPicker();

  if(on && BIZ_LIST.length){
    applyBiz(ACTIVE_BIZ);
  } else if(on && ME.biz){
    // An account with no businesses should not exist after migration 0010, but
    // falling back to the flat profile beats blanking somebody's letterhead.
    BIZ_FIELDS.forEach(f=>{ if(ME.biz[f]) $(f).value=ME.biz[f]; });
    if(typeof ME.biz.bizLogo==="string" && ME.biz.bizLogo) BIZ_LOGO=safeImgSrc(ME.biz.bizLogo);
    if(typeof ME.biz.bizSign==="string") BIZ_SIGN=ME.biz.bizSign;
    saveBiz(); syncLogoUI(); syncSignUI();
    applyDefaults(ME.defaults);
  }
  render();
}

async function openAuthModal(){
  $("authMsg").textContent=""; $("authMsg").className="msg";
  // load configured providers -> render SSO buttons
  const box=$("ssoButtons"); box.innerHTML="";
  let provs=[];
  try{ provs=(await api("/auth/providers")).providers||[]; }catch(e){}
  provs.forEach(p=>{
    // broker returns {id,name}; tolerate a bare "id" string too.
    const id = typeof p==="string" ? p : p.id;
    const name = (typeof p==="object" && p.name) ? ("Continue with "+p.name) : (PROVIDER_LABEL[id]||id);
    const a=document.createElement("a");
    a.className="btn"; a.href="/api/auth/oauth/"+id;
    a.innerHTML=(PROVIDER_SVG[id]||"")+"<span>"+name+"</span>";
    box.appendChild(a);
  });
  $("ssoDivider").hidden = provs.length===0;
  // Prefill the LOGIN email (the identity you sign in as), NOT the business
  // email printed on invoices — they're different. Use the last email you
  // logged in with, remembered locally.
  $("magicEmail").value = (ME && ME.email) || localStorage.getItem(LOGIN_EMAIL_KEY) || "";
  $("authModal").hidden=false;
  setTimeout(()=>$("magicEmail").focus(),50);
}
function closeAuthModal(){ $("authModal").hidden=true; }

function wireBackend(){
  $("btnTheme").onclick = () =>
    applyTheme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark");

  $("btnAuth").onclick = async () => {
    if(ME){ await api("/auth/logout",{method:"POST"}).catch(()=>{}); ME=null; return refreshMe(); }
    openAuthModal();
  };
  $("authClose").onclick = closeAuthModal;
  $("authModal").onclick = (e)=>{ if(e.target===$("authModal")) closeAuthModal(); };
  document.addEventListener("keydown",(e)=>{ if(e.key==="Escape") closeAuthModal(); });

  $("magicSend").onclick = async () => {
    const email=$("magicEmail").value.trim();
    const msg=$("authMsg");
    if(!email){ msg.className="msg err"; msg.textContent="Enter your email."; return; }
    msg.className="msg"; msg.textContent="Sending…";
    try{ const r=await api("/auth/request",{method:"POST",body:JSON.stringify({email})});
      try{ localStorage.setItem(LOGIN_EMAIL_KEY, email.toLowerCase()); }catch(_){}
      msg.className="msg ok"; msg.textContent=r.message||"Check your email for the link."; }
    catch(e){ msg.className="msg err"; msg.textContent="Could not send: "+e.message; }
  };

  /* Save the invoice, updating the one that is open rather than making another.

     Both this and Email used to POST unconditionally, so every press created a
     row. Now: PUT when we know which invoice we are editing, POST when it is
     genuinely new — and adopt the new id, so pressing Save twice updates once
     instead of producing twins.

     (Business profile / defaults are owned by the Settings modal; do NOT PUT
     /profile here — collect() has no biz fields and would blank them out.) */
  async function persistInvoice(){
    const body = JSON.stringify(collect());
    if(CURRENT_ID){
      const r = await api("/invoices/"+CURRENT_ID, {method:"PUT", body});
      return { id: CURRENT_ID, total: r.total };
    }
    const r = await api("/invoices", {method:"POST", body});
    CURRENT_ID = r.id;
    return r;
  }

  $("btnSave").onclick = async () => {
    // A paid invoice is locked, but its UPI reference is not part of the
    // document: record a new or corrected one on its own.
    if(CURRENT_ID && LOCKED_PAID && !LOCKED_PAID.rzp){
      const ref = cleanUpiRef($("upiRef").value);
      if(ref === null){ alert("Enter the UTR from your payment app (6 to 35 letters and digits) or a Razorpay payment id like pay_Ti9e3IaRPdRK95."); return; }
      if(ref !== LOCKED_PAID.ref){
        try{
          await api("/invoices/"+CURRENT_ID+"/upi-ref", {method:"POST", body: JSON.stringify({ upiRef: ref })});
          LOCKED_PAID.ref = ref; $("upiRef").value = ref; render();
          alert(ref ? "UPI reference saved ✓  (UTR "+ref+")" : "UPI reference cleared ✓");
        }catch(e){ alert("Could not save the UPI reference: "+e.message); }
        return;
      }
    }
    if($("status").value === "PAID" && cleanUpiRef($("upiRef").value) === null){
      alert("Enter the UTR from your payment app (6 to 35 letters and digits) or a Razorpay payment id like pay_Ti9e3IaRPdRK95."); return;
    }
    try{
      const r = await persistInvoice();
      if($("status").value === "PAID") LOCKED_PAID = { ref: cleanUpiRef($("upiRef").value) || "", rzp: false };
      alert("Saved ✓  (total "+$("currency").value+" "+r.total+")");
      render();   // a PUT can change nothing visible, but the status may have
    }catch(e){
      // The server refuses a paid invoice with a 409 and an explanation; show
      // that rather than burying it in "Save failed".
      alert("Save failed: "+e.message);
    }
  };
  /* Sending is not editing.

     A PAID invoice cannot be saved - updateInvoice refuses with a 409, on
     purpose, so a document the customer has paid against cannot be changed
     under them. But sending it is exactly what you do with a paid invoice. So
     an invoice that already exists is sent AS STORED, with the number typed
     into the prompt passed as a one-off override; only an invoice that has
     never been saved is saved first, because it needs an id to be sent at all.

     The first real send hit this: "WhatsApp failed: This invoice is paid and
     can no longer be edited" - the edit lock, not WhatsApp, and Meta was never
     reached. The email button had the same latent fault. */
  async function sendableId(){
    if(CURRENT_ID) return CURRENT_ID;
    const s = await persistInvoice();
    return s.id;
  }
  /* WhatsApp ▾ — three messages about this invoice, each previewed exactly as
     the customer will read it and sent only on confirmation:
       Send invoice     the paid invoice, PDF attached
       Share tracking   courier + tracking number (also records the shipment)
       Send delivered   (also stamps delivered_at)
     The preview text comes from the server, built from the SAME params the send
     uses, so there is no way for the two to disagree. */
  {
    const menu = $("waMenu"), caret = $("btnWaMore");
    const openMenu = (on) => { menu.hidden = !on; caret.setAttribute("aria-expanded", String(on)); };
    caret.onclick = (e) => { e.stopPropagation(); openMenu(menu.hidden); };
    document.addEventListener("click", (e) => { if(!$("waWrap").contains(e.target)) openMenu(false); });
    document.addEventListener("keydown", (e) => { if(e.key === "Escape") { openMenu(false); closeWa(); } });

    $("btnWa").onclick      = () => { openMenu(false); openWa("invoice"); };
    $("waInvoice").onclick  = () => { openMenu(false); openWa("invoice"); };
    $("waShipped").onclick  = () => { openMenu(false); openWa("shipped"); };
    $("waDelivered").onclick= () => { openMenu(false); openWa("delivered"); };
    $("waClose").onclick = $("waCancel").onclick = closeWa;

    let WA = null;            // { id, kind } while the modal is open
    let previewTimer = null;

    function closeWa(){ $("waModal").hidden = true; WA = null; }

    const TITLES = { invoice: "Send invoice on WhatsApp", shipped: "Share tracking on WhatsApp", delivered: "Send delivered on WhatsApp" };

    async function openWa(kind){
      let id;
      try{ id = await sendableId(); }catch(e){ alert("Save the invoice first: "+e.message); return; }
      WA = { id, kind };
      $("waTitle").textContent = TITLES[kind];
      $("waSub").textContent = "Nothing is sent until you confirm.";
      $("waTo").value = $("clPhone").value || "";
      $("waShipFields").hidden = kind !== "shipped";
      $("waMsg").textContent = ""; $("waTrackLink").textContent = "";
      $("waPreview").textContent = "Loading preview…"; $("waPreview").classList.add("pending");
      $("waSend").disabled = true;
      $("waModal").hidden = false;
      await refreshPreview(true);
    }

    async function refreshPreview(first){
      if(!WA) return;
      const q = new URLSearchParams({ kind: WA.kind });
      const to = $("waTo").value.trim(); if(to) q.set("to", to);
      if(WA.kind === "shipped"){
        q.set("courier", $("waCourier").value || "");
        q.set("tracking", $("waTracking").value || "");
      }
      let p;
      try{ p = await api("/invoices/"+WA.id+"/whatsapp/preview?"+q); }
      catch(e){ $("waPreview").textContent = ""; $("waMsg").textContent = "Couldn't build the preview: "+e.message; return; }
      if(!WA) return;
      if(first && WA.kind === "shipped"){
        // Courier dropdown from the server's list; preselect what the row has.
        const sel = $("waCourier"); sel.innerHTML = "";
        const opt0 = document.createElement("option"); opt0.value = ""; opt0.textContent = "Choose courier…"; sel.appendChild(opt0);
        for(const c of p.carriers){ const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; sel.appendChild(o); }
        sel.value = p.courier || "";
        $("waTracking").value = p.tracking || "";
      }
      if(first && p.to && !$("waTo").value) $("waTo").value = p.to;
      $("waPreview").textContent = p.text;
      $("waPreview").classList.toggle("pending", !p.canSend);
      $("waTrackLink").textContent = p.trackUrl ? "Customer's tracking link: "+p.trackUrl : "";
      const s = p.shipment || {};
      // An unpaid invoice goes out as a payment request (Pay online / Pay by UPI
      // buttons); its "already sent" is the request's own timestamp.
      const already = WA.kind === "invoice" ? (p.request ? s.wa_request_at : s.wa_sent_at)
                    : WA.kind === "shipped" ? s.wa_shipped_at : s.wa_delivered_at;
      $("waTitle").textContent = p.request ? "Request payment on WhatsApp" : TITLES[WA.kind];
      $("waSub").textContent = already
        ? "Already sent "+new Date(already).toLocaleString("en-IN")+". Sending again will send it again."
        : p.request ? "Unpaid, so this goes as a payment request: invoice PDF plus a Pay online button."
        : (p.pdf ? "The invoice PDF is attached to the message." : "Nothing is sent until you confirm.");
      $("waMsg").textContent = p.canSend ? "" : p.why;
      $("waSend").disabled = !p.canSend;
    }

    // Re-preview as the fields change, lightly debounced so typing a tracking
    // number does not fire a request per keystroke.
    const queue = () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => refreshPreview(false), 350); };
    $("waCourier").onchange = () => refreshPreview(false);
    $("waTracking").oninput = queue;
    $("waTo").oninput = queue;

    $("waSend").onclick = async () => {
      if(!WA) return;
      const body = { kind: WA.kind, to: $("waTo").value.trim() };
      if(WA.kind === "shipped"){ body.courier = $("waCourier").value; body.tracking = $("waTracking").value; }
      $("waSend").disabled = true; $("waMsg").textContent = "Sending…";
      try{
        const r = await api("/invoices/"+WA.id+"/whatsapp",{method:"POST",body:JSON.stringify(body)});
        $("waMsg").textContent = "";
        closeWa();
        alert("Sent on WhatsApp to "+(r.to||body.to)+" ✓");
      }catch(e){
        // The server's message already begins "WhatsApp failed:" - do not
        // prefix it twice.
        $("waMsg").textContent = /^whatsapp failed/i.test(e.message||"") ? e.message : "WhatsApp failed: "+e.message;
        $("waSend").disabled = false;
      }
    };
  }
  $("btnEmail").onclick = async () => {
    const to = prompt("Send invoice to (client email):", $("clEmail").value||"");
    if(!to) return;
    try{
      const id = await sendableId();            // see sendableId: a paid invoice cannot be re-saved
      const pdfBase64 = await tryRenderPdf();   // attach PDF if it renders
      await api("/invoices/"+id+"/email",{method:"POST",body:JSON.stringify({to, pdfBase64})});
      alert("Invoice emailed to "+to+" ✓"+(pdfBase64?" (PDF attached)":""));
    }catch(e){ alert("Email failed: "+e.message); }
  };

  const q=new URLSearchParams(location.search).get("auth");
  if(q==="ok") history.replaceState({},"","/");
  else if(q && q.startsWith("oauth_")) alert("Sign-in failed: "+q.replace("oauth_","OAuth "));
  else if(q==="invalid") alert("That sign-in link was invalid or expired.");
  refreshMe();
}
document.addEventListener("DOMContentLoaded", wireBackend);

