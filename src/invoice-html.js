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

// "Ledger desk" email — mirrors the on-screen invoice: warm-neutral sheet,
// pine-green ink, monospaced ledger figures, a double-rule grand total.
// Email-safe: inline styles + table layout, no <style>/@page. Figures use a
// mono stack with graceful fallback (some clients strip webfonts).
const MONO = "'IBM Plex Mono','SF Mono',Consolas,monospace";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const GREEN = "#2f7d54";
const INK = "#1b1e24";
const SOFT = "#5b6472";
const RULE = "#e7e9e6";

export function renderInvoiceEmail(inv, items) {
  const cur = inv.currency || "₹";
  const t = computeTotals(inv, items);
  const initial = (inv.biz_name || "I").charAt(0).toUpperCase();
  const discPct = inv.discount_pct || 0;

  const rows = items.filter((i) => i.description || i.qty || i.rate).map((i) => {
    const amt = (i.qty || 0) * (i.rate || 0);
    return `<tr>
      <td style="padding:11px 10px;border-bottom:1px solid ${RULE};font-weight:600">${esc(i.description)}</td>
      <td align="right" style="padding:11px 10px;border-bottom:1px solid ${RULE};font-family:${MONO};color:${SOFT}">${i.qty || ""}</td>
      <td align="right" style="padding:11px 10px;border-bottom:1px solid ${RULE};font-family:${MONO};color:${SOFT}">${i.rate ? Number(i.rate).toFixed(2) : ""}</td>
      <td align="right" style="padding:11px 10px;border-bottom:1px solid ${RULE};font-family:${MONO}">${money(cur, amt)}</td></tr>`;
  }).join("");

  const totRow = (label, val, opts = {}) =>
    `<tr><td style="padding:6px 10px;color:${SOFT}${opts.strong ? `;font-weight:600;color:${INK}` : ""}">${esc(label)}</td>
      <td align="right" style="padding:6px 10px;font-family:${MONO};color:${opts.strong ? INK : SOFT}">${opts.neg ? "– " : ""}${money(cur, val)}</td></tr>`;

  const taxRows = t.taxRows.map(([l, v]) => totRow(l, v)).join("");

  return `<div style="font-family:${SANS};color:${INK};max-width:640px;margin:0 auto;padding:8px">
  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid ${INK};padding-bottom:14px">
   <tr><td valign="top" style="padding:16px 0">
     ${inv.biz_logo
      ? `<img src="${esc(inv.biz_logo)}" alt="${esc(inv.biz_name || "Logo")}" style="max-width:150px;max-height:60px;display:block;margin-bottom:10px">`
      : `<span style="display:inline-block;width:44px;height:44px;background:${GREEN};color:#fff;font-family:${MONO};font-size:21px;font-weight:600;text-align:center;line-height:44px;border-radius:9px">${esc(initial)}</span>`}
     <div style="margin-top:9px"><b style="font-size:18px">${esc(inv.biz_name || "Your Business")}</b><br>
     <span style="color:${SOFT};font-size:12px">${esc(inv.biz_addr)}<br>${esc(inv.biz_email)}</span></div>
   </td>
   <td align="right" valign="top" style="padding:16px 0">
     <div style="font-size:24px;font-weight:700;color:${GREEN};letter-spacing:4px">INVOICE</div>
     <div style="font-size:12px;color:${SOFT};margin-top:8px">
       No. <b style="font-family:${MONO};color:${INK}">${esc(inv.number)}</b><br>
       Issued <b style="font-family:${MONO};color:${INK}">${esc(inv.issue_date)}</b>${inv.due_date ? `<br>Due <b style="font-family:${MONO};color:${INK}">${esc(inv.due_date)}</b>` : ""}
     </div>
   </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;font-size:12px">
   <tr><td valign="top" width="58%">
     <div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${SOFT};font-weight:700">Billed To</div>
     <b style="font-size:13px">${esc(inv.client_name || "Client")}</b><br><span style="color:${SOFT}">${esc(inv.client_addr)}<br>${esc(inv.client_email)}${inv.client_gst ? "<br>GSTIN: " + esc(inv.client_gst) : ""}</span>
   </td>
   <td valign="top" align="right">
     <div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${SOFT};font-weight:700">Pay To</div>
     <span style="color:${SOFT}">${esc(inv.biz_pay)}${inv.biz_gst ? "<br>GSTIN: " + esc(inv.biz_gst) : ""}</span>
   </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse">
   <tr style="color:${SOFT};font-size:9.5px;text-transform:uppercase;letter-spacing:1px">
    <td style="padding:8px 10px;border-bottom:2px solid ${INK}">Description</td>
    <td align="right" style="padding:8px 10px;border-bottom:2px solid ${INK}">Qty</td>
    <td align="right" style="padding:8px 10px;border-bottom:2px solid ${INK}">Rate</td>
    <td align="right" style="padding:8px 10px;border-bottom:2px solid ${INK}">Amount</td></tr>
   ${rows}
  </table>
  <table align="right" cellpadding="0" cellspacing="0" style="margin-top:16px;font-size:12px;width:56%">
   ${totRow("Subtotal", t.subtotal)}
   ${t.disc ? totRow(`Discount (${discPct}%)`, t.disc, { neg: true }) : ""}
   ${t.disc ? totRow("Taxable value", t.taxable) : ""}
   ${taxRows}
   <tr><td style="padding:12px 10px 6px;border-top:3px double ${RULE};font-family:${SANS};font-weight:700;text-transform:uppercase;letter-spacing:.6px">Total ${cur ? `(${esc(cur)})` : ""}</td>
       <td align="right" style="padding:12px 10px 6px;border-top:3px double ${RULE};font-family:${MONO};font-weight:600;font-size:18px;color:${GREEN}">${money(cur, t.total)}</td></tr>
  </table>
  <div style="clear:both"></div>
  ${inv.notes ? `<div style="margin-top:28px;font-size:11px;color:${SOFT};white-space:pre-line"><div style="text-transform:uppercase;font-size:9.5px;letter-spacing:1.4px;color:${SOFT};font-weight:700;margin-bottom:4px">Notes / Terms</div>${esc(inv.notes)}</div>` : ""}
  <div style="margin-top:26px;text-align:center;color:${SOFT};font-size:10px;font-family:${MONO};letter-spacing:.3px;border-top:1px solid ${RULE};padding-top:13px">Generated with Invoicer</div>
 </div>`;
}
