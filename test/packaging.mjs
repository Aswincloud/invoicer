// A packaging fee is a FEE, not a line item — and that distinction is the
// whole feature.
//
// A line item is a product: it lands in the items list, counts toward "Items N",
// and reads as something the customer bought. A fee for packing the order
// belongs below the subtotal with shipping, taxed with the goods it packs (a
// charge on a composite supply is part of the taxable value, not added after
// tax). These checks pin the arithmetic, the row's presence rules, and that the
// merchant's own words for it survive to the page.

import { computeTotals, packagingLabel, renderInvoiceEmail } from "../src/invoice-html.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};
const near = (a, b) => Math.abs(a - b) < 0.005;

console.log("— arithmetic —");
{
  const items = [{ qty: 2, rate: 500 }];                          // subtotal 1000
  const t = computeTotals({ tax_mode: "none", packaging: 30 }, items);
  check("fee is added to the total", near(t.total, 1030), String(t.total));
  check("fee is reported on its own", near(t.packaging, 30));
  check("subtotal is untouched — it is not a line item", near(t.subtotal, 1000));

  const g = computeTotals({ tax_mode: "gst", tax_rate: 18, packaging: 30, shipping: 50, discount_pct: 10 }, items);
  // 1000 − 100 + 50 + 30 = 980 taxable; ×1.18 = 1156.40
  check("joins the taxable value with shipping", near(g.taxable, 980), String(g.taxable));
  check("so tax applies to it", near(g.total, 1156.40), String(g.total));

  const z = computeTotals({ tax_mode: "none" }, items);
  check("absent means zero, not NaN", z.packaging === 0 && near(z.total, 1000));
  const s = computeTotals({ tax_mode: "none", packaging: "30" }, items);
  check("a string from the form is coerced", near(s.total, 1030));
}

console.log("\n— the label —");
check("blank label reads 'Packaging'", packagingLabel({}) === "Packaging");
check("whitespace label reads 'Packaging'", packagingLabel({ packaging_label: "  " }) === "Packaging");
check("the merchant's words survive", packagingLabel({ packaging_label: "Secure 3-layer packaging" }) === "Secure 3-layer packaging");

console.log("\n— the email row —");
{
  const base = { number: "T-1", issue_date: "2026-09-19", currency: "₹", tax_mode: "none",
                 status: "PAID", biz_name: "Aswin3DPrints", client_name: "X" };
  const items = [{ description: "Thing", qty: 1, rate: 100 }];
  const withFee = renderInvoiceEmail({ ...base, packaging: 30, packaging_label: "Secure 3-layer packaging" }, items);
  check("row appears with the label", withFee.includes("Secure 3-layer packaging"));
  check("row carries the amount", withFee.includes("30.00"));
  const noFee = renderInvoiceEmail({ ...base, packaging: 0 }, items);
  check("no fee, no row", !noFee.includes(">Packaging<"));
  // "Taxable value" names the base a tax was computed on — meaningless with no tax.
  const taxed = renderInvoiceEmail({ ...base, tax_mode: "gst", tax_rate: 18, packaging: 30 }, items);
  check("a fee under GST shows the taxable base", taxed.includes("Taxable value"));
  check("a fee with no tax does not", !withFee.includes("Taxable value"));
  // Escaping: a label is merchant-typed free text.
  const hostile = renderInvoiceEmail({ ...base, packaging: 30, packaging_label: "<b>x</b>" }, items);
  check("label is escaped in HTML", hostile.includes("&lt;b&gt;x&lt;/b&gt;") && !hostile.includes("<b>x</b>"));
}

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
