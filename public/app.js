/* Invoicer — client-side generator.
   No backend required: business profile persists in localStorage,
   PDF via the browser print engine. API hooks (save/email) added later. */
"use strict";

const $ = (id) => document.getElementById(id);
const BIZ_KEY = "invoicer.biz.v1";
const LOGIN_EMAIL_KEY = "invoicer.loginEmail.v1"; // last sign-in identity (≠ business email)

// Fields that make up the reusable "your business" profile.
const BIZ_FIELDS = ["bizName","bizEmail","bizAddr","bizPhone","bizGst","bizPay"];

// Optional business logo (data-URL). Not a form <input>, so it's tracked
// separately from BIZ_FIELDS and persisted alongside them.
let BIZ_LOGO = "";
// All fields we re-render the preview from.
const ALL_FIELDS = [...BIZ_FIELDS,"clName","clEmail","clAddr","clGst",
  "invNo","currency","issueDate","dueDate","discount","taxMode","taxRate",
  "shipping","shippingMode","shippingModeOther","status","notes"];

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
    `<input class="d" placeholder="Description — e.g. Consulting services" value="${esc(desc)}">`+
    `<div class="item-nums">`+
      `<label>Qty<input class="q" type="number" min="0" step="0.01" placeholder="1" value="${esc(qty)}"></label>`+
      `<label>Rate<input class="r" type="number" min="0" step="0.01" placeholder="0" value="${esc(rate)}"></label>`+
      `<label>Amount<input class="a" placeholder="0.00" disabled></label>`+
      `<button class="rm" title="Remove line item" aria-label="Remove line item">×</button>`+
    `</div>`;
  div.querySelector(".rm").onclick = () => { div.remove(); render(); };
  div.querySelectorAll("input").forEach(i => i.addEventListener("input", render));
  return div;
}
function addItem(desc,qty,rate){ $("items").appendChild(itemRow(desc,qty,rate)); }
function readItems(){
  return [...document.querySelectorAll("#items .item")].map(row => {
    const d = row.querySelector(".d").value;
    const rawQ = row.querySelector(".q").value.trim();
    const r = num(row.querySelector(".r").value);
    // Blank Qty means 1 — the placeholder says "1", and charging a rate × 0
    // silently zeroed the line, which is never what someone meant to invoice.
    const q = rawQ === "" ? 1 : num(rawQ);
    const amt = q*r;
    row.querySelector(".a").value = amt ? amt.toFixed(2) : "";
    return {desc:d, qty:q, rate:r, amt};
  });
}

// ── totals ───────────────────────────────────────────────────────
function computeTotals(items){
  const subtotal = items.reduce((s,i)=>s+i.amt,0);
  const disc = subtotal * num($("discount").value)/100;
  // Shipping joins the taxable value (GST treatment for freight), so tax applies
  // to it — mirrors computeTotals() in src/invoice-html.js.
  const shipping = num($("shipping").value);
  const taxable = subtotal - disc + shipping;
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
  return {subtotal, disc, shipping, taxable, taxRows, total: taxable + taxTotal};
}

// Effective mode of shipping: the dropdown value, or the free-text box when
// "Other…" is picked.
function shipMode(){
  const sel = $("shippingMode").value;
  return (sel === "__other" ? $("shippingModeOther").value : sel).trim().slice(0,60);
}
// Reveal the free-text box only for "Other…"; clear it otherwise so a stale
// value can never leak into the invoice.
function syncShippingMode(){
  const other = $("shippingMode").value === "__other";
  $("shippingModeOtherWrap").hidden = !other;
  if(!other) $("shippingModeOther").value = "";
}
// Inverse of shipMode(): a stored mode is free text, so route anything that
// isn't one of the presets back through "Other…".
function setShippingMode(mode){
  const m = String(mode || "");
  const preset = [...$("shippingMode").options].some(o => o.value === m && o.value !== "__other");
  if(m && !preset){
    $("shippingMode").value = "__other";
    syncShippingMode();
    $("shippingModeOther").value = m;
  } else {
    $("shippingMode").value = m;
    syncShippingMode();
  }
}

/* ── inferred fields ───────────────────────────────────────────────
   Anything derivable from what's already typed. Rules: only ever write into
   a field the user hasn't touched, and tag it "auto" so a value that appears
   on its own is never a surprise on a financial document. */

// Fields the user has edited by hand — inference leaves these alone forever.
const TOUCHED = new Set();

// A GSTIN starts with a 2-digit state code: 34ABCDE1234F1Z9 -> "34".
// Same state as the seller means CGST+SGST; different means IGST (one line).
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]Z?[A-Z\d]$/i;
function stateCode(gstin){
  const g = String(gstin || "").trim().toUpperCase();
  return GSTIN_RE.test(g) ? g.slice(0, 2) : "";
}
// Infer intra- vs inter-state tax from the two GSTINs. Returns "" when we
// can't tell (either GSTIN missing or malformed) so the caller leaves it be.
function inferTaxMode(){
  const mine = stateCode($("bizGst").value), theirs = stateCode($("clGst").value);
  if(!mine || !theirs) return "";
  return mine === theirs ? "gst" : "single";
}
function applyInference(){
  const note = $("taxModeAuto");
  // The user picking a tax mode by hand always wins.
  if(TOUCHED.has("taxMode")){ note.textContent = ""; return; }
  const want = inferTaxMode();
  if(!want){ note.textContent = ""; return; }
  if($("taxMode").value !== want) $("taxMode").value = want;
  const mine = stateCode($("bizGst").value), theirs = stateCode($("clGst").value);
  note.textContent = mine === theirs ? "auto · intra-state" : "auto · inter-state";
  note.title = `Derived from GSTIN state codes ${mine} → ${theirs}. Pick a mode yourself to override.`;
}

/* ── reverse solve: target total → product cost ────────────────────
   Given an all-in figure ("quote them 400"), undo tax, shipping and discount
   to get the subtotal the line items must add up to. Inverts computeTotals:

     total   = taxable × (1 + rate/100)      →  taxable  = total / (1 + rate/100)
     taxable = subtotal − discount% + ship   →  subtotal = (taxable − ship) / (1 − d/100)
*/
function solveSubtotal(total){
  const mode = $("taxMode").value;
  const rate = mode === "none" ? 0 : num($("taxRate").value);
  const taxable = total / (1 + rate/100);
  const ship = num($("shipping").value);
  const d = num($("discount").value);
  if(d >= 100) return { error: "A 100% discount can't reach a non-zero total." };
  const subtotal = (taxable - ship) / (1 - d/100);
  if(subtotal <= 0)
    return { error: `Shipping alone (${fmt(ship)}) already exceeds that total.` };
  return { subtotal, taxable, ship, rate, d };
}
// Push the solved subtotal onto the line items: with one row we set its rate
// (dividing by qty); with several we scale every rate proportionally so the
// mix the user built is preserved.
function applySolvedSubtotal(subtotal){
  const rows = [...document.querySelectorAll("#items .item")];
  const items = readItems();
  const priced = items.map((it,i) => ({it, i})).filter(x => x.it.desc || x.it.amt);
  const targets = priced.length ? priced : items.map((it,i)=>({it,i})).slice(0,1);
  if(!targets.length) return { error: "Add a line item first." };

  const current = targets.reduce((s,x) => s + x.it.amt, 0);
  if(targets.length === 1){
    const row = rows[targets[0].i];
    // A zero quantity can't reach a non-zero total no matter the rate, so
    // solving implies at least one unit — write the 1 in rather than leaving a
    // rate that silently multiplies out to nothing.
    let qty = targets[0].it.qty;
    if(qty <= 0){ qty = 1; row.querySelector(".q").value = "1"; }
    const rate = subtotal / qty;
    row.querySelector(".r").value = round2(rate);
    return { scaled:false, rate, qty };
  }
  if(current <= 0)
    return { error: "Give the line items rates first — we'll scale them to fit." };
  // Scale only the rows that actually contribute: a row at zero stays at zero
  // however we scale it, so rewriting its rate would be noise.
  const k = subtotal / current;
  const scaledRows = targets.filter(x => x.it.amt > 0);
  scaledRows.forEach(x => {
    const r = rows[x.i].querySelector(".r");
    r.value = round2(num(r.value) * k);
  });
  return { scaled:true, k, n:scaledRows.length };
}
const round2 = (n) => Math.round(n*100)/100;

// Solve, apply, then re-render and report. We state the total we actually
// landed on rather than the one asked for: rounding rates to paise means the
// result can sit a paisa off, and quietly showing the target would be a lie.
function solveFromTarget(){
  const msg = $("solveMsg");
  const say = (html, bad) => { msg.innerHTML = html; msg.classList.toggle("bad", !!bad); };
  const target = num($("targetTotal").value);
  if(target <= 0) return say("Enter the total you want to charge.", true);

  const s = solveSubtotal(target);
  if(s.error) return say(esc(s.error), true);
  const applied = applySolvedSubtotal(s.subtotal);
  if(applied.error) return say(esc(applied.error), true);

  render();
  const got = computeTotals(readItems()).total;
  const how = applied.scaled
    ? `scaled ${applied.n} line items by ×${round2(applied.k)}`
    : `set the rate to <b>${fmt(applied.rate)}</b>${applied.qty !== 1 ? ` × ${applied.qty}` : ""}`;
  const off = Math.abs(got - target);
  // Only rounding can explain a sub-paisa gap; anything larger is a real
  // mismatch and shouldn't be excused as rounding.
  const why = off < 0.02 ? " — rates round to paise" : "";
  say(`Subtotal <b>${fmt(s.subtotal)}</b> — ${how}. Total is now <b>${fmt(got)}</b>` +
      (off >= 0.01 ? ` (${fmt(off)} off the target${why}).` : "."));
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
    ${BIZ_LOGO
      ? `<img class="plogo-img" src="${esc(BIZ_LOGO)}" alt="${esc(v("bizName")||"Logo")}">`
      : `<div class="plogo">${esc(initial)}</div>`}
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
  ${t.disc?`<tr><td>Discount (${num($("discount").value)}%)</td><td class="r">– ${fmt(t.disc)}</td></tr>`:""}
  ${t.shipping?`<tr><td>Shipping${shipMode()?` (${esc(shipMode())})`:""}</td><td class="r">${fmt(t.shipping)}</td></tr>`:""}
  ${(t.disc||t.shipping)?`<tr><td>Taxable value</td><td class="r">${fmt(t.taxable)}</td></tr>`:""}
  ${taxHtml}
  <tr class="grand"><td>Total ${cur?`(${cur})`:""}</td><td class="r">${fmt(t.total)}</td></tr>
</table></div>

${v("notes")?`<div class="pfoot"><div class="lbl">Notes / Terms</div><p>${esc(v("notes"))}</p></div>`:""}
<div class="pnote">Generated with Invoicer · ${esc(v("bizEmail")||"")}</div>`;
}

// ── logo upload (downscaled to a data-URL) ───────────────────────
const LOGO_MAX = 320;         // px — longest edge; keeps the stored string small
const LOGO_MAX_BYTES = 180000; // ~180KB data-URL ceiling (server caps at 200KB)

// Read a File, downscale via canvas, return a data-URL. SVGs pass through as-is
// (vector — no raster step) but are still size-checked.
function fileToLogo(file){
  return new Promise((resolve, reject) => {
    if(!file) return reject(new Error("no file"));
    if(!/^image\//.test(file.type)) return reject(new Error("Please choose an image file."));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    if(file.type === "image/svg+xml"){
      reader.onload = () => {
        const s = String(reader.result||"");
        if(s.length > LOGO_MAX_BYTES) return reject(new Error("SVG is too large (max ~180KB)."));
        resolve(s);
      };
      return reader.readAsDataURL(file);
    }
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image couldn't be loaded."));
      img.onload = () => {
        const scale = Math.min(1, LOGO_MAX/Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width*scale));
        const h = Math.max(1, Math.round(img.height*scale));
        const c = document.createElement("canvas"); c.width=w; c.height=h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        // PNG preserves transparency; good default for logos.
        let out = c.toDataURL("image/png");
        if(out.length > LOGO_MAX_BYTES) out = c.toDataURL("image/jpeg", 0.85); // fallback: smaller
        if(out.length > LOGO_MAX_BYTES) return reject(new Error("Logo is too large after resizing. Try a simpler image."));
        resolve(out);
      };
      img.src = String(reader.result||"");
    };
    reader.readAsDataURL(file);
  });
}

// Reflect BIZ_LOGO into a thumbnail + buttons. Runs for BOTH the main business
// form (logo*) and the settings modal (setLogo*), since either may be present.
function syncLogoUI(){
  [["logoPreview","logoPlaceholder","logoClear"],
   ["setLogoPreview","setLogoPlaceholder","setLogoClear"]].forEach(([pv,ph,cl])=>{
    const img=$(pv); if(!img) return;
    const place=$(ph), clr=$(cl);
    if(BIZ_LOGO){ img.src=BIZ_LOGO; img.hidden=false; place.hidden=true; clr.hidden=false; }
    else { img.hidden=true; place.hidden=false; clr.hidden=true; }
  });
}

// Wire one pick/file/clear trio to the shared BIZ_LOGO. Both the main form and
// the settings modal call this with their own element ids.
function wireLogoTrio(pickId, fileId, clrId){
  const pick=$(pickId), file=$(fileId), clr=$(clrId);
  if(!pick) return;
  pick.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files && file.files[0];
    file.value = ""; // allow re-picking the same file
    if(!f) return;
    try{
      BIZ_LOGO = await fileToLogo(f);
      saveBiz(); syncLogoUI(); render();
      if(ME) persistLogo();   // logged in → also save to the account
    }catch(e){ alert(e.message || "Could not use that logo."); }
  };
  clr.onclick = () => {
    BIZ_LOGO = ""; saveBiz(); syncLogoUI(); render();
    if(ME) persistLogo();
  };
}

function wireLogo(){
  wireLogoTrio("logoPick", "logoFile", "logoClear");        // main business form
  wireLogoTrio("setLogoPick", "setLogoFile", "setLogoClear"); // settings modal
}

// Push the current business profile (fields + logo) to the account, best-effort.
// Defaults are preserved from ME so we never blank them. No-op when signed out.
async function persistProfile(){
  if(!ME) return;
  const biz={}; BIZ_FIELDS.forEach(f=>biz[f]=$(f).value); biz.bizLogo=BIZ_LOGO;
  ME.biz = {...(ME.biz||{}), ...biz, bizLogo: BIZ_LOGO}; // keep local mirror fresh
  try{ await api("/profile",{method:"PUT",body:JSON.stringify({...biz, defaults: ME.defaults||{}})}); }
  catch(e){ /* non-fatal; stays in localStorage */ }
}
const persistLogo = persistProfile; // logo pick/clear reuse the same push

// Debounced variant for typing in the business form, so we don't PUT on every keystroke.
let _profileTimer=null;
function persistProfileDebounced(){
  if(!ME) return;
  clearTimeout(_profileTimer);
  _profileTimer=setTimeout(persistProfile, 800);
}
document.addEventListener("DOMContentLoaded", wireLogo);

// ── persistence (business profile only) ──────────────────────────
function saveBiz(){
  const data = {}; BIZ_FIELDS.forEach(f => data[f] = $(f).value);
  data.bizLogo = BIZ_LOGO;
  try{ localStorage.setItem(BIZ_KEY, JSON.stringify(data)); }catch(e){}
}
function loadBiz(){
  try{
    const d = JSON.parse(localStorage.getItem(BIZ_KEY)||"{}");
    BIZ_FIELDS.forEach(f => { if(d[f]!=null) $(f).value = d[f]; });
    if(typeof d.bizLogo==="string") BIZ_LOGO = d.bizLogo;
  }catch(e){}
}

// ── init ─────────────────────────────────────────────────────────
function todayISO(d=0){ const t=new Date(); t.setDate(t.getDate()+d); return t.toISOString().slice(0,10); }
function init(){
  loadBiz();
  syncLogoUI();
  if(!$("issueDate").value) $("issueDate").value = todayISO(0);
  // Due date is optional — left blank by default. A user's Settings "due in
  // days" default (applyDefaults) will fill it if they've set one.
  if(!$("invNo").value)     $("invNo").value = "INV-" + new Date().getFullYear() + "-" +
      String(Math.floor(Math.random()*9000)+1000);

  // seed one example line item
  addItem("Consulting services","10","2500");

  ALL_FIELDS.forEach(f => $(f).addEventListener("input", render));
  $("shippingMode").addEventListener("change", () => { syncShippingMode(); render(); });
  syncShippingMode();

  // Inference: recompute when a source field changes, and stop touching a
  // field the moment the user sets it themselves.
  ["bizGst","clGst"].forEach(f =>
    $(f).addEventListener("input", () => { applyInference(); render(); }));
  $("taxMode").addEventListener("change", () => { TOUCHED.add("taxMode"); applyInference(); render(); });
  applyInference();

  $("btnSolve").onclick = solveFromTarget;
  $("targetTotal").addEventListener("keydown", e => {
    if(e.key === "Enter"){ e.preventDefault(); solveFromTarget(); }
  });
  // Business fields persist locally always, and to the account (debounced) when
  // signed in — so a logged-in user's profile lives in the cloud DB, not just
  // this device.
  BIZ_FIELDS.forEach(f => $(f).addEventListener("input", () => { saveBiz(); persistProfileDebounced(); }));
  $("btnAddItem").onclick = () => { addItem(); render(); };
  $("btnPrint").onclick = () => window.print();
  $("btnReset").onclick = () => {
    if(!confirm("Start a new blank invoice? (Your saved business details are kept.)")) return;
    ["clName","clEmail","clAddr","clGst","notes","shipping","shippingMode",
     "targetTotal"].forEach(f=>$(f).value="");
    syncShippingMode();
    $("solveMsg").textContent = "";
    TOUCHED.delete("taxMode");   // fresh invoice — infer again
    applyInference();
    $("items").innerHTML=""; addItem();
    $("invNo").value = "INV-"+new Date().getFullYear()+"-"+String(Math.floor(Math.random()*9000)+1000);
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
    status:v("status"),notes:v("notes"),
    clName:v("clName"),clEmail:v("clEmail"),clAddr:v("clAddr"),clGst:v("clGst"),
    items:readItems().filter(i=>i.desc||i.amt).map(i=>({description:i.desc,qty:i.qty,rate:i.rate}))};
}

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
async function renderInvoicePdfBase64(){
  await ensurePdfLibs();
  const canvas = await html2canvas($("paper"),
    {scale:2, backgroundColor:"#ffffff", useCORS:true, logging:false});
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
  const uri = doc.output("datauristring");     // data:application/pdf;...,<base64>
  return uri.slice(uri.indexOf(",")+1);
}

// Soft-fail wrapper: returns base64 PDF, or "" if it couldn't be produced.
// Server treats an empty/omitted pdfBase64 as "no attachment".
async function tryRenderPdf(){
  try{ return await renderInvoicePdfBase64(); }
  catch(e){ console.warn("PDF render failed; sending without attachment:", e); return ""; }
}

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
  $("btnSave").hidden = !on; $("btnEmail").hidden = !on;
  $("btnSettings").hidden = !on;
  $("btnInvoices").hidden = !on;
  $("bizHint").textContent = on ? "(synced to your account)" : "(saved on this device)";
  if(on && ME.biz){
    BIZ_FIELDS.forEach(f=>{ if(ME.biz[f]) $(f).value=ME.biz[f]; });
    if(typeof ME.biz.bizLogo==="string" && ME.biz.bizLogo) BIZ_LOGO=ME.biz.bizLogo;
    saveBiz(); syncLogoUI();
  }
  if(on) applyDefaults(ME.defaults);
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

  $("btnSave").onclick = async () => {
    // Save = create the invoice only. (Business profile / defaults are owned by
    // the Settings modal; do NOT PUT /profile here — collect() has no biz fields
    // and would blank them out.)
    try{ const r=await api("/invoices",{method:"POST",body:JSON.stringify(collect())});
      alert("Saved ✓  (total "+$("currency").value+" "+r.total+")"); }
    catch(e){ alert("Save failed: "+e.message); }
  };
  $("btnEmail").onclick = async () => {
    const to = prompt("Send invoice to (client email):", $("clEmail").value||"");
    if(!to) return;
    try{
      const s=await api("/invoices",{method:"POST",body:JSON.stringify(collect())});
      const pdfBase64 = await tryRenderPdf();   // attach PDF if it renders
      await api("/invoices/"+s.id+"/email",{method:"POST",body:JSON.stringify({to, pdfBase64})});
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

/* ── settings / per-user invoice defaults ──────────────────────── */
const SET_FIELDS = {  // modal field id -> defaults key
  setCurrency:"currency", setPrefix:"prefix", setTaxMode:"taxMode",
  setTaxRate:"taxRate", setDiscount:"discount", setDueDays:"dueDays", setNotes:"notes",
};
const SET_BIZ = { setBizName:"bizName", setBizEmail:"bizEmail", setBizAddr:"bizAddr",
  setBizPhone:"bizPhone", setBizGst:"bizGst", setBizPay:"bizPay" };

// Apply saved defaults to a fresh invoice. Only fills fields the user left at
// their generic default, so it never clobbers something already typed.
function applyDefaults(d){
  if(!d) return;
  if(d.currency) $("currency").value = d.currency;
  if(d.taxMode)  $("taxMode").value  = d.taxMode;
  if(d.taxRate!=="" && d.taxRate!=null) $("taxRate").value = d.taxRate;
  if(d.discount!=="" && d.discount!=null) $("discount").value = d.discount;
  if(d.notes && !$("notes").value) $("notes").value = d.notes;
  if(d.dueDays!=="" && d.dueDays!=null){
    const n=parseInt(d.dueDays,10); if(Number.isFinite(n)) $("dueDate").value = todayISO(n);
  }
  if(d.prefix){
    // rewrite the auto invoice number with the user's prefix
    $("invNo").value = d.prefix + "-" + new Date().getFullYear() + "-" +
      String(Math.floor(Math.random()*9000)+1000);
  }
  render();
}

function openSettings(){
  if(!ME) return;
  $("setMsg").textContent=""; $("setMsg").className="msg";
  const b=ME.biz||{}, d=ME.defaults||{};
  for(const [id,k] of Object.entries(SET_BIZ)) $(id).value = b[k]||"";
  for(const [id,k] of Object.entries(SET_FIELDS)) $(id).value = (d[k]!=null?d[k]:"");
  syncLogoUI();   // show the current logo in the modal's thumbnail
  $("setModal").hidden=false;
}
function closeSettings(){ $("setModal").hidden=true; }

async function saveSettings(){
  const msg=$("setMsg"); msg.className="msg"; msg.textContent="Saving…";
  const biz={}; for(const [id,k] of Object.entries(SET_BIZ)) biz[k]=$(id).value;
  biz.bizLogo = BIZ_LOGO;   // include the logo so saving Settings doesn't blank it
  const defaults={}; for(const [id,k] of Object.entries(SET_FIELDS)) defaults[k]=$(id).value;
  try{
    await api("/profile",{method:"PUT",body:JSON.stringify({...biz, defaults})});
    ME.biz={...ME.biz,...biz}; ME.defaults=defaults;
    // reflect business fields into the live form + localStorage immediately
    BIZ_FIELDS.forEach(f=>{ if(biz[f]!=null) $(f).value=biz[f]; }); saveBiz(); render();
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
         <div class="inv-sub">${esc(inv.client_name||"—")} · ${esc(invDate(inv.issue_date))}
           ${st?` · <span class="inv-badge ${esc(st)}">${esc(st)}</span>`:""}</div>
       </div>
       <div class="inv-right">
         <span class="inv-amt">${esc(invAmt(inv.currency, inv.total))}</span>
         <div class="inv-acts">
           <button class="btn ghost open">Open</button>
           <button class="btn ghost email">Email</button>
           <button class="btn ghost del">Delete</button>
         </div>
       </div>`;
    row.querySelector(".open").onclick  = () => openInvoiceInEditor(inv.id);
    row.querySelector(".email").onclick = () => emailSavedInvoice(inv);
    row.querySelector(".del").onclick   = () => deleteSavedInvoice(inv, row);
    box.appendChild(row);
  });
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
    $("targetTotal").value = ""; $("solveMsg").textContent = "";
    $("taxModeAuto").textContent = "";
    $("status").value   = (inv.status || "UNPAID");
    $("notes").value    = inv.notes || "";
    $("clName").value   = inv.client_name || "";
    $("clEmail").value  = inv.client_email || "";
    $("clAddr").value   = inv.client_addr || "";
    $("clGst").value    = inv.client_gst || "";
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
