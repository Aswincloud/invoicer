/* customers.js — pick a saved customer while typing the client name or mobile.
   Part of the client; loaded last (see core.js for the order). Shares the
   global scope with the other parts.

   Typing in Client name (2+ letters, or 3+ digits) or Client mobile (5+
   digits, while the name is empty) asks the server for matching saved
   customers. Picking one fills name, mobile, email, address and GSTIN — the
   owner chose to; nothing is filled without a pick. Customers are saved by the
   server on every invoice save, so there is no separate "save customer" step.

   Picking, Escape and leaving the boxes all cancel any pending search, so a
   reply arriving late can never reopen a list the owner has dismissed. */
"use strict";
(function(){
  const nameBox = $("clName"), phoneBox = $("clPhone"), list = $("custList");
  if(!nameBox || !list) return;
  let rows = [], active = -1, timer = null, seq = 0, owner = nameBox;   // owner: the box the list is open for

  const fmtPhone = (p) => p ? "+" + p : "";
  function setAria(open){
    for(const b of [nameBox, phoneBox]){
      if(!b) continue;
      const mine = open && b === owner;
      b.setAttribute("aria-expanded", String(mine));
      b.setAttribute("aria-controls", "custList");
      if(mine && active >= 0) b.setAttribute("aria-activedescendant", "cust-" + active); else b.removeAttribute("aria-activedescendant");
    }
  }
  function close(){ list.hidden = true; active = -1; setAria(false); }
  // Dismiss for good: cancel the debounce and invalidate any reply in flight.
  function dismiss(){ clearTimeout(timer); seq++; rows = []; close(); }

  function paint(){
    list.innerHTML = "";
    if(!rows.length){ close(); return; }
    rows.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "cust-item" + (i === active ? " active" : "");
      item.setAttribute("role", "option"); item.id = "cust-" + i;
      item.setAttribute("aria-selected", String(i === active));
      const city = (c.addr || "").split(/\n|,/).map((s) => s.trim()).filter(Boolean).pop() || "";
      item.innerHTML = `<div class="cust-main"><b>${esc(c.name)}</b>${c.phone ? ` <span>${esc(fmtPhone(c.phone))}</span>` : ""}</div>
        <div class="cust-sub">${esc(city)}${c.invoices ? ` · ${c.invoices} invoice${c.invoices === 1 ? "" : "s"}` : ""}</div>
        <button type="button" class="cust-del" title="Forget this saved customer" aria-label="Forget ${esc(c.name)}">×</button>`;
      item.addEventListener("mousedown", (e) => {
        if(e.target.closest(".cust-del")) return;     // the button's own click handles it
        e.preventDefault();                           // keep focus in the box
        pick(c);
      });
      const del = item.querySelector(".cust-del");
      del.addEventListener("mousedown", (e) => e.preventDefault());   // don't blur the box (which would close the list)
      del.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); forget(c); });   // mouse, Enter and Space
      list.appendChild(item);
    });
    list.hidden = false; setAria(true);
  }

  async function search(q, from, { selectFirst = false } = {}){
    const mine = ++seq;
    try{
      const r = await api("/customers?q=" + encodeURIComponent(q));
      if(mine !== seq) return;                         // superseded or dismissed
      owner = from; rows = r.customers || []; active = selectFirst && rows.length ? 0 : -1; paint();
    }catch(_){ if(mine === seq){ rows = []; close(); } }
  }

  function setField(id, v){ const e = $(id); if(!e) return; e.value = v || ""; e.dispatchEvent(new Event("input", { bubbles: true })); }
  function pick(c){
    dismiss();
    setField("clName", c.name);
    setField("clPhone", fmtPhone(c.phone));
    setField("clEmail", c.email);
    setField("clAddr", c.addr);
    setField("clGst", c.gst);
    if(typeof applyInference === "function") applyInference();
    if(typeof update === "function") update();
  }
  let confirming = false;     // the confirm dialog blurs the box; onBlur must not dismiss
  async function forget(c){
    confirming = true;
    const ok = confirm(`Forget ${c.name}${c.phone ? " (" + fmtPhone(c.phone) + ")" : ""} from saved customers?\n\nTheir invoices are not affected.`);
    confirming = false;
    if(!ok){ owner.focus(); return; }
    try{
      await api("/customers/" + encodeURIComponent(c.id), { method: "DELETE" });
      rows = rows.filter((x) => x.id !== c.id); active = Math.min(active, rows.length - 1); paint(); owner.focus();
    }catch(e){ alert("Couldn't forget the customer: " + e.message); }
  }

  // Arrow keys, Enter and Escape drive the list from whichever box opened it.
  function onKey(e){
    if(list.hidden || !rows.length) return;
    if(e.key === "ArrowDown"){ e.preventDefault(); active = (active + 1) % rows.length; paint(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); active = (active - 1 + rows.length) % rows.length; paint(); }
    else if(e.key === "Enter" && active >= 0){ e.preventDefault(); pick(rows[active]); }
    else if(e.key === "Escape"){ e.preventDefault(); dismiss(); }
  }
  // Leaving the boxes closes the list, unless focus moved into the list itself
  // (the Forget button) or to the other box. It only closes: it must not cancel
  // a search the other box has just started (moving from mobile to name and
  // typing at once did exactly that).
  function onBlur(){
    setTimeout(() => {
      const f = document.activeElement;
      if(confirming || list.contains(f) || f === nameBox || f === phoneBox) return;
      dismiss();
    }, 120);
  }

  nameBox.addEventListener("input", (e) => {
    if(!e.isTrusted) return;                         // our own fills (pick, reset, reopen) don't search
    clearTimeout(timer);
    const q = nameBox.value.trim(), digits = q.replace(/\D/g, "");
    if(!ME || (q.length < 2 && digits.length < 3)){ dismiss(); return; }
    timer = setTimeout(() => search(q, nameBox), 180);
  });
  nameBox.addEventListener("keydown", onKey);
  nameBox.addEventListener("blur", onBlur);

  if(phoneBox){
    phoneBox.addEventListener("input", (e) => {
      if(!e.isTrusted || nameBox.value.trim()) return;   // only while the name is still empty
      clearTimeout(timer);
      const d = phoneBox.value.replace(/\D/g, "");
      if(!ME || d.length < 5){ dismiss(); return; }
      timer = setTimeout(() => search(d, phoneBox, { selectFirst: true }), 220);
    });
    phoneBox.addEventListener("keydown", onKey);
    phoneBox.addEventListener("blur", onBlur);
  }
})();
