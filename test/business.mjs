// An invoice belongs to the business that issued it, forever.
//
// This is the regression the whole multi-business design exists to prevent, so
// it is worth stating plainly. Business details are not columns on the invoice;
// they are joined in at render time. Before this change they were joined from
// the USER row, which meant they were really "whatever the account looks like
// right now". With one business that is invisible. With two it means:
//
//   raise INV-AC-… under AswinCloud (GST registered, bank details, no shop)
//   switch the account to Aswin3DPrints (different GSTIN, different UPI, a QR)
//   reprint or re-email that AswinCloud invoice
//   -> it comes out headed Aswin3DPrints, with 3DPrints' GSTIN and bank details
//
// A wrong GSTIN on a tax invoice is not a cosmetic bug. So each invoice carries
// business_id, and the checks below drive the real resolution path with the
// account's default pointed at the OTHER business throughout.

import { attachBusiness, bizFields, defaultBusiness, publicBusiness,
         businessPatch } from "../src/business.js";
import { renderInvoiceEmail, computeTotals, qrAttachment } from "../src/invoice-html.js";
import { renderInvoicePdf } from "../src/invoice-pdf.js";

let failed = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "   " + detail : ""}`);
  if (!cond) failed++;
};

const CLOUD = {
  id: "b-cloud", user_id: "u-1", is_default: 0, created_at: 1,
  biz_name: "AswinCloud", biz_email: "billing@aswincloud.com",
  biz_addr: "Puducherry", biz_phone: "+91 90000 00000",
  biz_gst: "34ABCDE1234F1Z9", biz_pay: "UPI aswincloud@hdfcbank", biz_logo: "",
  qr_url: "", qr_caption: "",
  def_prefix: "INV-AC", def_tax_mode: "gst", def_tax_rate: "18", def_currency: "₹",
  def_discount: "", def_notes: "", def_due_days: "",
};
const PRINTS = {
  id: "b-3dp", user_id: "u-1", is_default: 1, created_at: 2,   // <- the DEFAULT
  biz_name: "Aswin3DPrints", biz_email: "shop@aswincloud.com",
  biz_addr: "Puducherry", biz_phone: "+91 90000 11111",
  biz_gst: "33ZZZZZ9999Z9Z9", biz_pay: "UPI 3dprints@okicici", biz_logo: "",
  qr_url: "https://3d-prints.aswincloud.com", qr_caption: "Scan for more prints",
  def_prefix: "INV-3DP", def_tax_mode: "none", def_tax_rate: "0", def_currency: "₹",
  def_discount: "", def_notes: "", def_due_days: "",
};

// Just enough D1 to drive src/business.js for real, rather than stubbing it.
const ENV = {
  DB: {
    prepare(sql) {
      const s = sql.replace(/\s+/g, " ").trim();
      const mk = (args) => ({
        bind: (...a) => mk(a),
        async first() {
          if (s.startsWith("SELECT * FROM businesses WHERE id=? AND user_id=?"))
            return [CLOUD, PRINTS].find((b) => b.id === args[0] && b.user_id === args[1]) || null;
          if (s.startsWith("SELECT * FROM businesses WHERE user_id=?"))
            return [CLOUD, PRINTS]
              .filter((b) => b.user_id === args[0])
              .sort((x, y) => (y.is_default - x.is_default) || (x.created_at - y.created_at))[0] || null;
          throw new Error("unhandled SQL: " + s);
        },
      });
      return mk([]);
    },
  },
};

const ITEMS = [{ description: "Benchy", qty: 2, rate: 250 }];

console.log("— the default is 3DPrints, so a wrong lookup would return it —");
const dflt = await defaultBusiness(ENV, "u-1");
check("default resolves to Aswin3DPrints", dflt.id === "b-3dp", dflt.biz_name);

console.log("\n— an AswinCloud invoice keeps AswinCloud —");
const cloudInv = { id: "i-1", user_id: "u-1", business_id: "b-cloud",
                   number: "INV-AC-2026-6142", currency: "₹", tax_mode: "gst", status: "UNPAID" };
await attachBusiness(ENV, cloudInv);
check("name", cloudInv.biz_name === "AswinCloud", cloudInv.biz_name);
check("GSTIN", cloudInv.biz_gst === "34ABCDE1234F1Z9", cloudInv.biz_gst);
check("pay-to", cloudInv.biz_pay === "UPI aswincloud@hdfcbank", cloudInv.biz_pay);
check("no shop link, so no QR", !cloudInv.qr_url, cloudInv.qr_url);

const cloudHtml = renderInvoiceEmail(cloudInv, ITEMS);
check("email shows AswinCloud", cloudHtml.includes("AswinCloud"));
check("email does NOT leak 3DPrints", !cloudHtml.includes("Aswin3DPrints"));
check("email does NOT leak the other GSTIN", !cloudHtml.includes("33ZZZZZ9999Z9Z9"));
check("email carries no order QR", !cloudHtml.includes("Order online"));
check("no QR attachment either", qrAttachment(cloudInv) === null);

const cloudPdf = new TextDecoder("latin1")
  .decode(renderInvoicePdf(cloudInv, ITEMS, computeTotals(cloudInv, ITEMS)));
check("PDF shows AswinCloud", cloudPdf.includes("(AswinCloud)"));
check("PDF does NOT leak 3DPrints", !cloudPdf.includes("Aswin3DPrints"));

console.log("\n— a 3DPrints invoice gets 3DPrints, and its QR —");
const printsInv = { id: "i-2", user_id: "u-1", business_id: "b-3dp",
                    number: "INV-3DP-2026-4821", currency: "₹", tax_mode: "none", status: "PAID" };
await attachBusiness(ENV, printsInv);
check("name", printsInv.biz_name === "Aswin3DPrints", printsInv.biz_name);
check("GSTIN", printsInv.biz_gst === "33ZZZZZ9999Z9Z9", printsInv.biz_gst);
check("shop link came through", printsInv.qr_url === "https://3d-prints.aswincloud.com");

const printsHtml = renderInvoiceEmail(printsInv, ITEMS, { qrSrc: "cid:orderqr@invoicer" });
check("email shows the order block", printsHtml.includes("Order online"));
check("email shows the caption", printsHtml.includes("Scan for more prints"));
check("email links the shop", printsHtml.includes("https://3d-prints.aswincloud.com"));
check("email references the CID image", printsHtml.includes("cid:orderqr@invoicer"));

const qr = qrAttachment(printsInv);
check("a QR attachment is produced", Boolean(qr) && qr.attachment.content.length > 100);
check("it is a PNG with a content id", qr && qr.attachment.content_type === "image/png"
  && qr.attachment.content_id === "orderqr@invoicer");

const printsPdf = new TextDecoder("latin1")
  .decode(renderInvoicePdf(printsInv, ITEMS, computeTotals(printsInv, ITEMS)));
check("PDF shows Aswin3DPrints", printsPdf.includes("(Aswin3DPrints)"));
check("PDF prints the caption", printsPdf.includes("(Scan for more prints)"));
// The QR is vector rects; `re f` is the PDF fill operator.
check("PDF draws QR modules as vectors", (printsPdf.match(/ re f/g) || []).length > 40,
  String((printsPdf.match(/ re f/g) || []).length));

console.log("\n— a legacy row with no business_id still renders —");
const orphan = { id: "i-3", user_id: "u-1", business_id: null, currency: "₹", status: "UNPAID" };
await attachBusiness(ENV, orphan);
check("falls back to the account default", orphan.biz_name === "Aswin3DPrints", orphan.biz_name);
check("every field is a string, never undefined",
  ["biz_name", "biz_gst", "biz_pay", "qr_url"].every((k) => typeof orphan[k] === "string"));

console.log("\n— a missing business does not throw mid-render —");
const blank = bizFields(null);
check("blank rather than undefined", blank.biz_name === "" && blank.qr_url === "");
const blankInv = { id: "i-4", currency: "₹", status: "UNPAID", ...blank };
let blankHtml = null;
try { blankHtml = renderInvoiceEmail(blankInv, ITEMS); } catch (e) { console.log("   threw:", e.message); }
check("still renders an email rather than throwing", Boolean(blankHtml) && blankHtml.length > 500);
check("the line items are still on it", blankHtml && blankHtml.includes("Benchy"));
check("no 'undefined' leaked into the output", blankHtml && !blankHtml.includes("undefined"));

console.log("\n— a partial save leaves absent fields alone —");
// The Settings modal sends its own subset of fields. When a missing key meant
// "", every save through it silently blanked whatever it did not know about:
// first the logo, then the shop link, then the signature. Absent must mean
// untouched, or this keeps costing a field per feature.
const settingsSave = businessPatch({
  bizName: "Aswin3DPrints", bizEmail: "shop@aswincloud.com", bizLogo: "",
  defaults: { currency: "₹", prefix: "INV-3DP" },
});
check("updates what it was given", settingsSave.cols.includes("biz_name")
  && settingsSave.cols.includes("def_prefix"));
check("does NOT touch the signature", !settingsSave.cols.includes("biz_sign"),
  settingsSave.cols.join(","));
check("does NOT touch the shop link", !settingsSave.cols.includes("qr_url"));
check("an empty string IS a value", businessPatch({ bizSign: "" }).cols.includes("biz_sign"),
  "clearing has to be possible, so absent and empty are different things");
check("nothing to write yields nothing", businessPatch({}).cols.length === 0);
check("oversized uploads are clamped",
  businessPatch({ bizSign: "x".repeat(300000) }).vals[0].length === 200000);

console.log("\n— what the browser is told —");
const pub = publicBusiness(PRINTS);
check("carries its own prefix", pub.defaults.prefix === "INV-3DP", pub.defaults.prefix);
check("carries its own tax mode", pub.defaults.taxMode === "none", pub.defaults.taxMode);
check("ships pre-encoded QR rows", Array.isArray(pub.qrRows) && pub.qrRows.length > 20);
check("rows are the wire format", pub.qrRows.every((r) => /^[01]+$/.test(r)));
check("a business with no shop ships no rows", publicBusiness(CLOUD).qrRows === null);
check("the logo is not lost", typeof pub.biz.bizLogo === "string");

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
