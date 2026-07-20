/* Invoicer — client-side generator.
   No backend required: business profile persists in localStorage,
   PDF via the browser print engine. API hooks (save/email) added later. */
"use strict";

const $ = (id) => document.getElementById(id);
const BIZ_KEY = "invoicer.biz.v1";

// Fields that make up the reusable "your business" profile.
const BIZ_FIELDS = ["bizName","bizEmail","bizAddr","bizPhone","bizGst","bizPay"];
// All fields we re-render the preview from.
const ALL_FIELDS = [...BIZ_FIELDS,"clName","clEmail","clAddr","clGst",
  "invNo","currency","issueDate","dueDate","discount","taxMode","taxRate","status","notes"];

// ── money helpers ────────────────────────────────────────────────
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function fmt(n){
  // Indian grouping for ₹, western otherwise — purely presentational.
  const cur = $("currency").value;
  const opts = {minimumFractionDigits:2, maximumFractionDigits:2};
  const loc = cur === "₹" ? "en-IN" : "en-US";
  return (cur ? cur + " " : "") + n.toLocaleString(loc, opts);
}
const esc = (s) => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// ── line items ───────────────────────────────────────────────────
function itemRow(desc="",qty="1",rate=""){
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML =
    `<input class="d" placeholder="Description" value="${esc(desc)}">`+
    `<input class="q" type="number" min="0" step="0.01" placeholder="Qty" value="${esc(qty)}">`+
    `<input class="r" type="number" min="0" step="0.01" placeholder="Rate" value="${esc(rate)}">`+
    `<input class="a" placeholder="Amount" disabled>`+
    `<button class="rm" title="Remove">×</button>`;
  div.querySelector(".rm").onclick = () => { div.remove(); render(); };
  div.querySelectorAll("input").forEach(i => i.addEventListener("input", render));
  return div;
}
function addItem(desc,qty,rate){ $("items").appendChild(itemRow(desc,qty,rate)); }
function readItems(){
  return [...document.querySelectorAll("#items .item")].map(row => {
    const d = row.querySelector(".d").value;
    const q = num(row.querySelector(".q").value);
    const r = num(row.querySelector(".r").value);
    const amt = q*r;
    row.querySelector(".a").value = amt ? amt.toFixed(2) : "";
    return {desc:d, qty:q, rate:r, amt};
  });
}

// ── totals ───────────────────────────────────────────────────────
function computeTotals(items){
  const subtotal = items.reduce((s,i)=>s+i.amt,0);
  const disc = subtotal * num($("discount").value)/100;
  const taxable = subtotal - disc;
  const mode = $("taxMode").value;
  const rate = num($("taxRate").value);
  let taxRows = [], taxTotal = 0;
  if(mode === "gst"){
    const half = taxable * (rate/2)/100;
    taxRows = [[`CGST (${(rate/2)}%)`, half], [`SGST (${(rate/2)}%)`, half]];
    taxTotal = half*2;
  } else if(mode === "single"){
    const t = taxable * rate/100;
    taxRows = [[`Tax (${rate}%)`, t]]; taxTotal = t;
  }
  return {subtotal, disc, taxable, taxRows, total: taxable + taxTotal};
}

// ── render preview ───────────────────────────────────────────────
function render(){
  const items = readItems();
  const t = computeTotals(items);
  const v = (id) => $(id).value.trim();
  const cur = $("currency").value;
  const status = v("status") || "UNPAID";
  const initial = (v("bizName")||"I").trim().charAt(0).toUpperCase();

  const rowsHtml = items.filter(i=>i.desc||i.amt).map(i =>
    `<tr><td>${esc(i.desc)}</td><td class="r">${i.qty||""}</td>`+
    `<td class="r">${i.rate?i.rate.toFixed(2):""}</td>`+
    `<td class="r">${i.amt?fmt(i.amt):""}</td></tr>`).join("")
    || `<tr><td colspan="4" style="color:#9ca3af;text-align:center;padding:20px">Add line items to see them here…</td></tr>`;

  const taxHtml = t.taxRows.map(([l,val]) =>
    `<tr><td>${esc(l)}</td><td class="r">${fmt(val)}</td></tr>`).join("");

  $("paper").innerHTML =
`<div class="ph">
  <div class="brand">
    <div class="plogo">${esc(initial)}</div>
    <h1>${esc(v("bizName")||"Your Business")}</h1>
    <p>${esc(v("bizAddr"))}</p>
    <p>${esc(v("bizPhone"))}${v("bizPhone")&&v("bizEmail")?" · ":""}${esc(v("bizEmail"))}</p>
    ${v("bizGst")?`<p>GSTIN: ${esc(v("bizGst"))}</p>`:""}
  </div>
  <div class="title">
    <h2>INVOICE</h2>
    <div class="meta">
      ${v("invNo")?`<div>Invoice # <b>${esc(v("invNo"))}</b></div>`:""}
      ${v("issueDate")?`<div>Issue: <b>${esc(v("issueDate"))}</b></div>`:""}
      ${v("dueDate")?`<div>Due: <b>${esc(v("dueDate"))}</b></div>`:""}
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
  </div>
  <div style="text-align:right">
    <div class="lbl">Pay To</div>
    <p>${esc(v("bizPay"))}</p>
  </div>
</div>

<table class="lines">
  <thead><tr><th style="width:48%">Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>

<div class="totbox"><table>
  <tr><td>Subtotal</td><td class="r">${fmt(t.subtotal)}</td></tr>
  ${t.disc?`<tr><td>Discount</td><td class="r">– ${fmt(t.disc)}</td></tr><tr><td>Taxable value</td><td class="r">${fmt(t.taxable)}</td></tr>`:""}
  ${taxHtml}
  <tr class="grand"><td>Total ${cur?`(${cur})`:""}</td><td class="r">${fmt(t.total)}</td></tr>
</table></div>

${v("notes")?`<div class="pfoot"><div class="lbl">Notes / Terms</div><p>${esc(v("notes"))}</p></div>`:""}
<div class="pnote">Generated with Invoicer · ${esc(v("bizEmail")||"")}</div>`;
}

// ── persistence (business profile only) ──────────────────────────
function saveBiz(){
  const data = {}; BIZ_FIELDS.forEach(f => data[f] = $(f).value);
  try{ localStorage.setItem(BIZ_KEY, JSON.stringify(data)); }catch(e){}
}
function loadBiz(){
  try{
    const d = JSON.parse(localStorage.getItem(BIZ_KEY)||"{}");
    BIZ_FIELDS.forEach(f => { if(d[f]!=null) $(f).value = d[f]; });
  }catch(e){}
}

// ── init ─────────────────────────────────────────────────────────
function todayISO(d=0){ const t=new Date(); t.setDate(t.getDate()+d); return t.toISOString().slice(0,10); }
function init(){
  loadBiz();
  if(!$("issueDate").value) $("issueDate").value = todayISO(0);
  if(!$("dueDate").value)   $("dueDate").value   = todayISO(14);
  if(!$("invNo").value)     $("invNo").value = "INV-" + new Date().getFullYear() + "-" +
      String(Math.floor(Math.random()*9000)+1000);

  // seed one example line item
  addItem("Consulting services","10","2500");

  ALL_FIELDS.forEach(f => $(f).addEventListener("input", render));
  BIZ_FIELDS.forEach(f => $(f).addEventListener("input", saveBiz));
  $("btnAddItem").onclick = () => { addItem(); render(); };
  $("btnPrint").onclick = () => window.print();
  $("btnReset").onclick = () => {
    if(!confirm("Start a new blank invoice? (Your saved business details are kept.)")) return;
    ["clName","clEmail","clAddr","clGst","notes"].forEach(f=>$(f).value="");
    $("items").innerHTML=""; addItem();
    $("invNo").value = "INV-"+new Date().getFullYear()+"-"+String(Math.floor(Math.random()*9000)+1000);
    $("issueDate").value=todayISO(0); $("dueDate").value=todayISO(14);
    render();
  };
  render();
}
document.addEventListener("DOMContentLoaded", init);

/* ── backend integration (auth + save + email) ─────────────────────
   Degrades gracefully: with no session, Sign in prompts a magic link;
   Save/Email stay hidden until authenticated. */
const api = (path, opts={}) =>
  fetch("/api"+path, {credentials:"same-origin",
    headers:{"content-type":"application/json"}, ...opts})
    .then(async r => { const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||r.status); return d; });

function collect(){
  const v=id=>$(id).value;
  return {number:v("invNo"),issueDate:v("issueDate"),dueDate:v("dueDate"),
    currency:v("currency"),taxMode:v("taxMode"),taxRate:v("taxRate"),
    discount:v("discount"),status:v("status"),notes:v("notes"),
    clName:v("clName"),clEmail:v("clEmail"),clAddr:v("clAddr"),clGst:v("clGst"),
    items:readItems().filter(i=>i.desc||i.amt).map(i=>({description:i.desc,qty:i.qty,rate:i.rate}))};
}

let ME=null;
async function refreshMe(){
  try{ ME=(await api("/me")).user; }catch(e){ ME=null; }
  const on=!!ME;
  $("who").textContent = on ? ME.email : "";
  $("btnAuth").textContent = on ? "Sign out" : "Sign in";
  $("btnSave").hidden = !on; $("btnEmail").hidden = !on;
  // hydrate saved business profile from server (overrides localStorage once logged in)
  if(on && ME.biz){ BIZ_FIELDS.forEach(f=>{ if(ME.biz[f]) $(f).value=ME.biz[f]; }); saveBiz(); render(); }
}

function wireBackend(){
  $("btnAuth").onclick = async () => {
    if(ME){ await api("/auth/logout",{method:"POST"}).catch(()=>{}); ME=null; return refreshMe(); }
    const email = prompt("Email to sign in (we'll send a magic link):", $("bizEmail").value||"");
    if(!email) return;
    try{ const r=await api("/auth/request",{method:"POST",body:JSON.stringify({email})});
      alert(r.message||"Check your email for the sign-in link."); }
    catch(e){ alert("Could not send link: "+e.message); }
  };
  $("btnSave").onclick = async () => {
    try{ await api("/profile",{method:"PUT",body:JSON.stringify(collect())}).catch(()=>{});
      const r=await api("/invoices",{method:"POST",body:JSON.stringify(collect())});
      alert("Saved ✓  (total "+$("currency").value+" "+r.total+")"); }
    catch(e){ alert("Save failed: "+e.message); }
  };
  $("btnEmail").onclick = async () => {
    const to = prompt("Send invoice to (client email):", $("clEmail").value||"");
    if(!to) return;
    try{ const s=await api("/invoices",{method:"POST",body:JSON.stringify(collect())});
      await api("/invoices/"+s.id+"/email",{method:"POST",body:JSON.stringify({to})});
      alert("Invoice emailed to "+to+" ✓"); }
    catch(e){ alert("Email failed: "+e.message); }
  };
  // show a toast if we just came back from a magic link
  const q=new URLSearchParams(location.search).get("auth");
  if(q==="ok") history.replaceState({},"","/");
  if(q==="invalid") alert("That sign-in link was invalid or expired. Try again.");
  refreshMe();
}
document.addEventListener("DOMContentLoaded", wireBackend);
