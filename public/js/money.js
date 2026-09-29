/* money.js — money formatting, line items, totals, tax inference, the target-total solver, update().
   Part of the client; see core.js for the load order. Shares the global scope with the other parts. */
"use strict";
// ── money helpers ────────────────────────────────────────────────
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function fmt(n){
  // Indian grouping for ₹, western otherwise — purely presentational. The
  // symbol is free text from the currency box and every fmt() result lands in
  // innerHTML, so it is escaped here, once, rather than at fifteen call sites.
  const cur = esc($("currency").value);
  const opts = {minimumFractionDigits:2, maximumFractionDigits:2};
  const loc = cur === "₹" ? "en-IN" : "en-US";
  return (cur ? cur + " " : "") + n.toLocaleString(loc, opts);
}
const esc = (s) => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// A stored logo/signature becomes an <img src>. Only two shapes are allowed
// through — an https URL, or a base64 image data URL rebuilt from its parts —
// so nothing else that found its way into localStorage or a profile can.
function safeImgSrc(u){
  u = String(u||"");
  if(/^https:\/\//i.test(u)){ try{ return new URL(u).href; }catch(e){ return ""; } }
  const m = u.match(/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i);
  return m ? "data:image/" + m[1].toLowerCase() + ";base64," + m[2].replace(/\s+/g,"") : "";
}

// ── line items ───────────────────────────────────────────────────
function itemRow(desc="",qty="1",rate=""){
  const div = document.createElement("div");
  div.className = "item";
  div.innerHTML =
    `<input class="d" placeholder="Description — e.g. Consulting services" value="${esc(desc)}">`+
    `<div class="item-nums">`+
      // Qty arrows move by 1 — counting units is the norm, and the old 0.01 step
      // made them crawl. A fractional qty (2.5 kg, 1.5 hours) still computes
      // correctly because readItems() parses .value directly, but it does count
      // as :invalid under this step. That's deliberate: step="any" restores
      // validity yet makes stepUp() throw InvalidStateError, killing the arrows
      // altogether. Nothing calls checkValidity(), so working arrows win — just
      // don't add form validation here without revisiting this.
      `<label>Qty<input class="q" type="number" min="0" step="1" placeholder="1" value="${esc(qty)}"></label>`+
      `<label>Rate<input class="r" type="number" min="0" step="0.01" placeholder="0" value="${esc(rate)}"></label>`+
      `<label>Amount<input class="a" placeholder="0.00" disabled></label>`+
      `<button class="rm" title="Remove line item" aria-label="Remove line item">×</button>`+
    `</div>`;
  div.querySelector(".rm").onclick = () => { div.remove(); update(); };
  div.querySelectorAll("input").forEach(i => i.addEventListener("input", update));
  // Auto-solve holds off while you're typing in a rate; rescale when you leave.
  div.querySelector(".r").addEventListener("blur", update);
  return div;
}
function addItem(desc,qty,rate){ $("items").appendChild(itemRow(desc,qty,rate)); }
function readItems(){
  return [...document.querySelectorAll("#items .item")].map(row => {
    const d = row.querySelector(".d").value;
    const rawQ = row.querySelector(".q").value.trim();
    const rawR = row.querySelector(".r").value.trim();
    const r = num(rawR);
    // Blank Qty means 1 — the placeholder says "1", and charging a rate × 0
    // silently zeroed the line, which is never what someone meant to invoice.
    const q = rawQ === "" ? 1 : num(rawQ);
    const amt = q*r;
    // Blank only while nothing has been entered. Once a rate is typed — even
    // "0" — the amount shows, so a free line reads as 0.00 instead of looking
    // like a row somebody forgot to fill in.
    row.querySelector(".a").value = (amt || rawR !== "") ? amt.toFixed(2) : "";
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
  // Packaging is a fee on the same footing as shipping — mirrors the server.
  const packaging = num($("packaging").value);
  const taxable = subtotal - disc + shipping + packaging;
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
  // Round the grand total to a whole unit, showing the adjustment as its own
  // line. Standard GST presentation: subtotal, discount, shipping and each tax
  // row stay exact and auditable, and a visible "Round off" absorbs the paise
  // so the figures on the page still add up to the total.
  const gross = taxable + taxTotal;
  const total = $("roundOff").checked ? Math.round(gross) : gross;
  return {subtotal, disc, shipping, packaging, taxable, taxRows, gross, round: total - gross, total};
}

// The packaging row's label: free text so "Secure 3-layer packaging" prints as
// written, plain "Packaging" when left blank. Mirrors packagingLabel() server-side.
function pkgLabel(){
  return $("packagingLabel").value.trim().slice(0,60) || "Packaging";
}

// Show the round-off row only when it actually moves the total. An adjustment
// under half a paisa displays as "0.00" (or "-0.00"), which reads as a bug
// rather than a rounding, so those are suppressed instead of printed.
const showRound = (t) => Math.abs(t.round) >= 0.005;

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
   Given an all-in figure ("quote them 400"), undo tax, fees and discount to
   get the subtotal the line items must add up to. Inverts computeTotals:

     total   = taxable × (1 + rate/100)           →  taxable  = total / (1 + rate/100)
     taxable = subtotal − discount% + ship + pkg  →  subtotal = (taxable − ship − pkg) / (1 − d/100)
*/
function solveSubtotal(total){
  const mode = $("taxMode").value;
  const rate = mode === "none" ? 0 : num($("taxRate").value);
  const taxable = total / (1 + rate/100);
  const ship = num($("shipping").value);
  const pkg  = num($("packaging").value);
  const d = num($("discount").value);
  if(d >= 100) return { error: "A 100% discount can't reach a non-zero total." };
  const subtotal = (taxable - ship - pkg) / (1 - d/100);
  if(subtotal <= 0)
    return { error: `Shipping and packaging alone (${fmt(ship + pkg)}) already exceed that total.` };
  return { subtotal, taxable, ship, pkg, rate, d };
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

// Solve and apply, reporting what happened. Doesn't render — update() does
// that once, after this has written the rates.
function solveFromTarget(){
  const msg = $("solveMsg");
  const say = (html, bad) => { msg.innerHTML = html; msg.classList.toggle("bad", !!bad); };
  const target = num($("targetTotal").value);
  if(target <= 0){ say(""); return; }

  const s = solveSubtotal(target);
  if(s.error) return say(esc(s.error), true);
  const applied = applySolvedSubtotal(s.subtotal);
  if(applied.error) return say(esc(applied.error), true);

  // The total we actually reached, not the one asked for: rates round to paise,
  // so the result can sit a paisa off and echoing the target back would be a lie.
  const got = computeTotals(readItems()).total;
  // "scaled by ×1" means the rates were already on target — say that instead.
  const k = round2(applied.k);
  const how = applied.scaled
    ? (k === 1 ? `line items already on target`
               : `scaled ${applied.n} line items by ×${k}`)
    : `rate <b>${fmt(applied.rate)}</b>${applied.qty !== 1 ? ` × ${applied.qty}` : ""}`;
  const off = Math.abs(got - target);
  // A target with paise in it can't be hit while the total is being rounded to
  // whole units — say so plainly rather than reporting an unexplained gap the
  // user can't act on.
  const fractional = Math.abs(target - Math.round(target)) >= 0.005;
  const why = $("roundOff").checked && fractional
    ? " — round off is on, so the total lands on a whole " + esc($("currency").value || "unit")
    // Only rounding can explain a sub-paisa gap; anything larger is a real
    // mismatch and shouldn't be excused as rounding.
    : (off < 0.02 ? " — rates round to paise" : "");
  say(`Solved: subtotal <b>${fmt(s.subtotal)}</b>, ${how}. Total <b>${fmt(got)}</b>` +
      (off >= 0.01 ? ` (${fmt(off)} off${why}).` : "."));
}

/* Auto-solve keeps the total pinned to the target while you edit anything else.
   Two rules stop it fighting the user:
     · it never runs while the caret is in a rate box — your typing stands, and
       the rescale happens when you leave the field;
     · unchecking "Auto-calculate" hands the rates back to you entirely. */
let SOLVING = false;
const editingRate = () => {
  const el = document.activeElement;
  return !!(el && el.classList && el.classList.contains("r"));
};
function shouldAutoSolve(){
  if(!$("autoSolve").checked) return false;
  if(num($("targetTotal").value) <= 0) return false;
  return !editingRate();
}
// The single entry point for "something changed": solve if we should, then paint.
// When we don't solve, the note is cleared rather than left behind — a stale
// "Total ₹400.00" sitting next to a total that is no longer 400 is worse than
// no note at all.
function update(){
  if(!SOLVING && shouldAutoSolve()){
    SOLVING = true;
    try{ solveFromTarget(); } finally{ SOLVING = false; }
  } else if(!SOLVING){
    const msg = $("solveMsg");
    const paused = $("autoSolve").checked && num($("targetTotal").value) > 0 && editingRate();
    msg.textContent = paused ? "Editing a rate — will re-solve to the target when you're done." : "";
    msg.classList.remove("bad");
  }
  render();
}

