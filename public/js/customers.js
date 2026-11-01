/* customers.js — pick a saved customer while typing the client name.
   Part of the client; loaded last (see core.js for the order). Shares the
   global scope with the other parts.

   Typing in Client name (2+ letters, or 3+ digits of a mobile) asks the server
   for matching saved customers. Picking one fills name, mobile, email, address
   and GSTIN, replacing what was there — the owner chose to. Nothing is filled
   without a pick. Customers are saved by the server on every invoice save, so
   there is no separate "save customer" step. */
"use strict";
(function(){
  const input = $("clName"), list = $("custList");
  if(!input || !list) return;
  let rows = [], active = -1, timer = null, seq = 0;

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const fmtPhone = (p) => p ? "+" + p : "";

  function paint(){
    list.innerHTML = "";
    if(!rows.length){ close(); return; }
    rows.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "cust-item" + (i === active ? " active" : "");
      item.setAttribute("role", "option"); item.id = "cust-" + i;
      const city = (c.addr || "").split(/\n|,/).map((s) => s.trim()).filter(Boolean).pop() || "";
      item.innerHTML = `<div class="cust-main"><b>${esc(c.name)}</b>${c.phone ? ` <span>${esc(fmtPhone(c.phone))}</span>` : ""}</div>
        <div class="cust-sub">${esc(city)}${c.invoices ? ` · ${c.invoices} invoice${c.invoices === 1 ? "" : "s"}` : ""}</div>
        <button type="button" class="cust-del" title="Forget this saved customer" aria-label="Forget ${esc(c.name)}">×</button>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();          // keep focus in the input
        if(e.target.closest(".cust-del")) return forget(c);
        pick(c);
      });
      list.appendChild(item);
    });
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", active >= 0 ? "cust-" + active : "");
  }

  async function search(){
    const q = input.value.trim(), digits = q.replace(/\D/g, "");
    if(!ME || (q.length < 2 && digits.length < 3)){ rows = []; close(); return; }
    const mine = ++seq;
    try{
      const r = await api("/customers?q=" + encodeURIComponent(q));
      if(mine !== seq) return;               // a newer search is in flight
      rows = (r.customers || []).filter((c) => !(c.name === q && rows.length === 1));
      active = -1; paint();
    }catch(_){ if(mine === seq){ rows = []; close(); } }
  }

  function setField(id, v){ const e = $(id); if(!e) return; e.value = v || ""; e.dispatchEvent(new Event("input", { bubbles: true })); }
  function pick(c){
    setField("clName", c.name);
    setField("clPhone", fmtPhone(c.phone));
    setField("clEmail", c.email);
    setField("clAddr", c.addr);
    setField("clGst", c.gst);
    rows = []; close();
    if(typeof applyInference === "function") applyInference();
    if(typeof update === "function") update();
  }
  async function forget(c){
    if(!confirm(`Forget ${c.name}${c.phone ? " (" + fmtPhone(c.phone) + ")" : ""} from saved customers?\n\nTheir invoices are not affected.`)) return;
    try{ await api("/customers/" + encodeURIComponent(c.id), { method: "DELETE" }); rows = rows.filter((x) => x.id !== c.id); paint(); }
    catch(e){ alert("Couldn't forget the customer: " + e.message); }
  }

  input.addEventListener("input", (e) => {
    if(!e.isTrusted) return;                 // our own fills (pick, reset, reopen) don't search
    clearTimeout(timer); timer = setTimeout(search, 180);
  });
  // Arrow keys, Enter and Escape drive the list from either box it opens from.
  const onKey = (e) => {
    if(list.hidden || !rows.length) return;
    if(e.key === "ArrowDown"){ e.preventDefault(); active = (active + 1) % rows.length; paint(); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); active = (active - 1 + rows.length) % rows.length; paint(); }
    else if(e.key === "Enter" && active >= 0){ e.preventDefault(); pick(rows[active]); }
    else if(e.key === "Escape"){ e.preventDefault(); close(); }
  };
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", () => setTimeout(close, 120));
  // Typing a mobile first? Same search from the phone box.
  const phone = $("clPhone");
  if(phone){ phone.addEventListener("keydown", onKey); phone.addEventListener("blur", () => setTimeout(close, 120)); }
  if(phone) phone.addEventListener("input", (e) => {
    if(!e.isTrusted || input.value.trim()) return;      // only while the name is still empty
    const d = phone.value.replace(/\D/g, "");
    if(d.length < 5) return;
    clearTimeout(timer); timer = setTimeout(async () => {
      const mine = ++seq;
      try{
        const r = await api("/customers?q=" + encodeURIComponent(d));
        if(mine !== seq) return;
        rows = r.customers || []; active = rows.length ? 0 : -1; paint();
      }catch(_){}
    }, 220);
  });
})();
