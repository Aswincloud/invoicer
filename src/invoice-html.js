// Server-side invoice HTML (for the "email invoice to client" feature).
// Kept email-safe: inline styles, table layout, no <style>/@page.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function money(cur, n) {
  const loc = cur === "₹" ? "en-IN" : "en-US";
  return (cur ? cur + " " : "") +
    Number(n || 0).toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function computeTotals(inv, items) {
  const subtotal = items.reduce((s, i) => s + (i.qty || 0) * (i.rate || 0), 0);
  const disc = subtotal * (inv.discount_pct || 0) / 100;
  const taxable = subtotal - disc;
  const rate = inv.tax_rate || 0;
  let taxRows = [], taxTotal = 0;
  if (inv.tax_mode === "gst") {
    const half = taxable * (rate / 2) / 100;
    taxRows = [[`CGST (${rate / 2}%)`, half], [`SGST (${rate / 2}%)`, half]];
    taxTotal = half * 2;
  } else if (inv.tax_mode === "single") {
    const t = taxable * rate / 100;
    taxRows = [[`Tax (${rate}%)`, t]]; taxTotal = t;
  }
  return { subtotal, disc, taxable, taxRows, total: taxable + taxTotal };
}

export function renderInvoiceEmail(inv, items) {
  const cur = inv.currency || "₹";
  const t = computeTotals(inv, items);
  const initial = (inv.biz_name || "I").charAt(0).toUpperCase();

  const rows = items.filter((i) => i.description || i.qty || i.rate).map((i, n) => {
    const amt = (i.qty || 0) * (i.rate || 0);
    const bg = n % 2 ? "#f8f9fc" : "#ffffff";
    return `<tr style="background:${bg}">
      <td style="padding:10px 12px;border-bottom:1px solid #eceef3"><b>${esc(i.description)}</b></td>
      <td align="right" style="padding:10px 12px;border-bottom:1px solid #eceef3">${i.qty || ""}</td>
      <td align="right" style="padding:10px 12px;border-bottom:1px solid #eceef3">${i.rate ? Number(i.rate).toFixed(2) : ""}</td>
      <td align="right" style="padding:10px 12px;border-bottom:1px solid #eceef3">${money(cur, amt)}</td></tr>`;
  }).join("");

  const taxRows = t.taxRows.map(([l, v]) =>
    `<tr><td style="padding:6px 12px">${esc(l)}</td><td align="right" style="padding:6px 12px">${money(cur, v)}</td></tr>`).join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a2e;max-width:640px;margin:0 auto">
  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:3px solid #4f46e5;padding-bottom:8px">
   <tr><td style="padding:16px 0">
     <span style="display:inline-block;width:44px;height:44px;background:#4f46e5;color:#fff;font-size:22px;font-weight:bold;text-align:center;line-height:44px;border-radius:10px">${esc(initial)}</span>
     <div style="margin-top:8px"><b style="font-size:18px">${esc(inv.biz_name || "Your Business")}</b><br>
     <span style="color:#6b7280;font-size:12px">${esc(inv.biz_addr)}<br>${esc(inv.biz_email)}</span></div>
   </td>
   <td align="right" valign="top" style="padding:16px 0">
     <div style="font-size:26px;font-weight:bold;color:#4f46e5;letter-spacing:2px">INVOICE</div>
     <div style="font-size:12px;color:#374151;margin-top:6px">
       Invoice # <b>${esc(inv.number)}</b><br>Issue: <b>${esc(inv.issue_date)}</b>${inv.due_date ? `<br>Due: <b>${esc(inv.due_date)}</b>` : ""}
     </div>
   </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;font-size:12px">
   <tr><td valign="top" width="60%">
     <div style="text-transform:uppercase;font-size:10px;letter-spacing:1px;color:#9ca3af;font-weight:bold">Billed To</div>
     <b>${esc(inv.client_name || "Client")}</b><br><span style="color:#4b5563">${esc(inv.client_addr)}<br>${esc(inv.client_email)}${inv.client_gst ? "<br>GSTIN: " + esc(inv.client_gst) : ""}</span>
   </td>
   <td valign="top" align="right">
     <div style="text-transform:uppercase;font-size:10px;letter-spacing:1px;color:#9ca3af;font-weight:bold">Pay To</div>
     <span style="color:#4b5563">${esc(inv.biz_pay)}${inv.biz_gst ? "<br>GSTIN: " + esc(inv.biz_gst) : ""}</span>
   </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
   <tr style="background:#4f46e5;color:#fff;font-size:10px;text-transform:uppercase">
    <td style="padding:10px 12px">Description</td><td align="right" style="padding:10px 12px">Qty</td>
    <td align="right" style="padding:10px 12px">Rate</td><td align="right" style="padding:10px 12px">Amount</td></tr>
   ${rows}
  </table>
  <table align="right" cellpadding="0" cellspacing="0" style="margin-top:14px;font-size:12px;width:55%">
   <tr><td style="padding:6px 12px">Subtotal</td><td align="right" style="padding:6px 12px">${money(cur, t.subtotal)}</td></tr>
   ${t.disc ? `<tr><td style="padding:6px 12px">Discount</td><td align="right" style="padding:6px 12px">– ${money(cur, t.disc)}</td></tr>` : ""}
   ${taxRows}
   <tr><td style="padding:10px 12px;background:#0f172a;color:#fff;font-weight:bold;font-size:14px;border-radius:6px 0 0 6px">Total</td>
       <td align="right" style="padding:10px 12px;background:#0f172a;color:#fff;font-weight:bold;font-size:14px;border-radius:0 6px 6px 0">${money(cur, t.total)}</td></tr>
  </table>
  <div style="clear:both"></div>
  ${inv.notes ? `<div style="margin-top:26px;font-size:11px;color:#374151"><div style="text-transform:uppercase;font-size:10px;letter-spacing:1px;color:#9ca3af;font-weight:bold">Notes</div>${esc(inv.notes)}</div>` : ""}
  <div style="margin-top:24px;text-align:center;color:#9ca3af;font-size:10px;border-top:1px solid #eee;padding-top:12px">Sent via Invoicer</div>
 </div>`;
}
