/* profile.js — business profile persistence, the business picker, collapsible sections.
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// ── persistence (business profile only) ──────────────────────────
function saveBiz(){
  const data = {}; BIZ_FIELDS.forEach(f => data[f] = $(f).value);
  data.bizLogo = BIZ_LOGO;
  data.qrUrl = fld("bizQrUrl");
  data.qrCaption = fld("bizQrCaption");
  data.bizSign = BIZ_SIGN;
  data.receiptLogo = RECEIPT_LOGO;
  data.upiVpa = fld("bizUpiVpa");
  data.payQr = fld("bizPayQr");
  try{ localStorage.setItem(BIZ_KEY, JSON.stringify(data)); }catch(e){}
}
function loadBiz(){
  try{
    const d = JSON.parse(localStorage.getItem(BIZ_KEY)||"{}");
    BIZ_FIELDS.forEach(f => { if(d[f]!=null) $(f).value = d[f]; });
    if(typeof d.bizLogo==="string") BIZ_LOGO = safeImgSrc(d.bizLogo);
    if(typeof d.qrUrl==="string") $("bizQrUrl").value = d.qrUrl;
    if(typeof d.qrCaption==="string") $("bizQrCaption").value = d.qrCaption;
    if(typeof d.bizSign==="string") BIZ_SIGN = d.bizSign;
    if(typeof d.receiptLogo==="string") RECEIPT_LOGO = d.receiptLogo;
    if(typeof d.upiVpa==="string") $("bizUpiVpa").value = d.upiVpa;
    if(typeof d.payQr==="string") $("bizPayQr").value = d.payQr;
  }catch(e){}
}

/* ── switching between businesses ─────────────────────────────────

   The list comes from the account (ME.businesses). localStorage still holds a
   single profile and always will: it is the signed-out fallback, where there is
   one business by definition and nothing to switch between. So no migration is
   needed here — an existing stored blob keeps loading into the form exactly as
   it did, and signing in replaces it with the account's list. */

/* Offer the UPI address already visible in Payment details — as a suggestion.

   Production has biz_pay = "UPI ID - 9000000000@examplebank\nGPay - 9000000000".
   The address is sitting right there, and making somebody retype it invites a
   typo in the one field where a typo sends a customer's money to a stranger.

   But it is offered, never adopted. Parsing prose at PRINT time would be the
   dangerous version: the same regex would match an email address typed there
   later, and nobody re-reads a QR. Clicking the suggestion writes it into an
   explicit field, once, where it can be seen and corrected.

   The validation mirrors isVpa() in src/upi.js. The server re-checks, so this
   only decides whether to bother asking. */
const VPA_RE = /\b([\w.\-]{2,64}@[a-zA-Z][\w\-]{1,32})\b/;

function syncVpaHint(){
  const box = $("vpaHint"); if(!box) return;
  const current = fld("bizUpiVpa");
  const m = VPA_RE.exec(fld("bizPay"));
  const found = m && m[1];

  if(current || !found){ box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `Found <code>${esc(found)}</code> in your payment details. `+
                  `<button type="button" id="vpaUse">Use it</button>`;
  $("vpaUse").onclick = () => {
    $("bizUpiVpa").value = found;
    saveBiz(); syncVpaHint(); render();
    if(ME) persistProfile();
  };
}

function renderBizPicker(){
  const wrap = $("bizSwitch"), sel = $("bizPicker");
  if(!wrap || !sel) return;

  // Only meaningful signed in, and only worth showing once there is a choice to
  // make — or a way to make one, which is why it appears at a single business
  // too (the ＋ New button is how the second one gets created).
  wrap.hidden = !ME;
  if(!ME) return;

  sel.innerHTML = BIZ_LIST.map(b =>
    `<option value="${esc(b.id)}"${b.id===ACTIVE_BIZ?" selected":""}>`+
    `${esc(b.biz.bizName || "Untitled business")}</option>`).join("");
  $("bizDelete").disabled = BIZ_LIST.length < 2;
}

/* Fill the form from one business, and adopt its defaults.

   Not while an existing invoice is open: that invoice was ISSUED by a business,
   the server will not let the business change on an edit, and quietly rewriting
   the letterhead in front of the user would be a lie about what is stored. */
function applyBiz(id){
  const b = BIZ_LIST.find((x) => x.id === id);
  if(!b) return;
  ACTIVE_BIZ = id;

  BIZ_FIELDS.forEach(f => { $(f).value = b.biz[f] || ""; });
  BIZ_LOGO = safeImgSrc(b.biz.bizLogo);
  BIZ_SIGN = b.biz.bizSign || "";
  RECEIPT_LOGO = b.biz.receiptLogo || "";
  $("bizQrUrl").value = b.biz.qrUrl || "";
  $("bizUpiVpa").value = b.biz.upiVpa || "";
  $("bizPayQr").value = b.biz.payQr || "";
  $("bizQrCaption").value = b.biz.qrCaption || "";
  BIZ_QR_CAPTION = b.biz.qrCaption || "";
  syncLogoUI();
  syncSignUI();
  syncReceiptLogoUI();
  saveBiz();
  syncVpaHint();
  syncBizHint();

  // applyDefaults already refuses to renumber while an invoice is open.
  applyDefaults(b.defaults || {});
  renderBizPicker();
  applyInference();
  render();
}

async function createBizProfile(){
  const name = (prompt("Name for the new business?") || "").trim();
  if(!name) return;
  try{
    const r = await api("/businesses", {method:"POST", body:JSON.stringify({bizName:name})});
    await refreshBusinesses();
    applyBiz(r.id);
  }catch(e){ alert("Couldn't create it: " + (e.message || e)); }
}

async function deleteBizProfile(){
  const b = activeBiz();
  if(!b) return;
  if(BIZ_LIST.length < 2) return;
  if(!confirm(`Delete "${b.biz.bizName || "this business"}"?\n\n`+
              `Invoices already issued under it keep their details, so it can `+
              `only be deleted if it has none.`)) return;
  try{
    await api("/businesses/" + encodeURIComponent(b.id), {method:"DELETE"});
    await refreshBusinesses();
    applyBiz((BIZ_LIST[0] || {}).id);
  }catch(e){ alert(e.message || e); }
}

async function refreshBusinesses(){
  const r = await api("/businesses");
  BIZ_LIST = r.businesses || [];
  if(!BIZ_LIST.find((x) => x.id === ACTIVE_BIZ))
    ACTIVE_BIZ = (BIZ_LIST.find((x) => x.isDefault) || BIZ_LIST[0] || {}).id || null;
  renderBizPicker();
}

/* ── which sections are open ──────────────────────────────────────

   "Your business" now ships COLLAPSED. It is set-once-per-business data — name,
   GSTIN, logo, signature, two payment QRs — and it had grown to fill the pane,
   pushing the fields that change on every invoice below the fold. The per-
   invoice sections (Bill to, Invoice details, Line items, Totals) stay open.

   The choice is then remembered, because a default is only right until someone
   disagrees with it, and re-opening the same section on every load is the kind
   of small friction that never gets reported. */
const SECTIONS_KEY = "invoicer.sections.v1";

function wireSections(){
  let saved = {};
  try{ saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}"); }catch(_){}

  document.querySelectorAll(".form details.grp[id]").forEach(d => {
    if(typeof saved[d.id] === "boolean") d.open = saved[d.id];
    d.addEventListener("toggle", () => {
      let all = {};
      try{ all = JSON.parse(localStorage.getItem(SECTIONS_KEY) || "{}"); }catch(_){}
      all[d.id] = d.open;
      try{ localStorage.setItem(SECTIONS_KEY, JSON.stringify(all)); }catch(_){}
    });
  });
}

/* What the collapsed "Your business" header says.

   With the section shut, the trading name on the invoice is otherwise invisible
   — and since an account can hold several, "which letterhead is this going out
   under" is exactly the question the header should answer at a glance. Falls
   back to where the details are stored when there is no name to show. */
function syncBizHint(){
  const el = $("bizHint"); if(!el) return;
  const name = fld("bizName");
  if(name){
    el.textContent = ME ? name : `${name} — saved on this device`;
    return;
  }
  el.textContent = ME ? "(synced to your account)" : "(saved on this device)";
}

