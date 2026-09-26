// Offline tests for invoices raised from paid shop orders.
//
// Run: node test/ingest.mjs
//
// The first tests in this project. Convention borrowed from the shop
// (3d_printing/test/*.mjs), which these invoices come from: no framework, plain
// node, and a fake D1 that THROWS on unrecognised SQL so a changed query cannot
// quietly turn a test green.
//
// The thing being protected here is one number. The customer has already been
// charged; if the invoice says something different, the document is worse than
// useless — it makes both numbers look wrong and turns a routine email into a
// support argument. So the total is asserted in paise, as an integer, for every
// awkward combination of shipping and discount that can occur.

import { ingestOrder, ingestShipment, buildInvoice } from "../src/ingest.js";
import { computeTotals, renderInvoiceEmail, logoAttachment } from "../src/invoice-html.js";
import { hmacHex } from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const SECRET = "test-ingest-secret-not-for-production";

const USER = {
  id: "u-1", email: "aswin@aswincloud.com",
  biz_name: "AswinPrints", biz_email: "aswin@aswincloud.com",
  biz_addr: "No.76, Venkata Nagar, Pondicherry", biz_phone: "",
  biz_gst: "", biz_pay: "Paid online", biz_logo: "",
};

const ENV = {
  SHOP_INGEST_ENABLED: "true",
  SHOP_INGEST_SECRET: SECRET,
  INVOICE_OWNER_EMAIL: "aswin@aswincloud.com",
  RESEND_API_KEY: "re_fake_for_tests",
  RESEND_FROM_EMAIL: "notify@aswincloud.com",
};

// A paid order as the shop sends it. Tests override only what they exercise.
const ORDER = () => ({
  ts: Date.now(),
  receipt: "AP-1a2b3c4d",
  paid_at: Date.parse("2026-08-06T10:00:00Z"),
  customer: {
    name: "Test Buyer", email: "buyer@example.com", phone: "9876543210",
    addr_line: "12 Some Street", addr_city: "Chennai",
    addr_state: "Tamil Nadu", addr_pin: "600001",
  },
  items: [{ name: "Dragon", qty: 1, price_paise: 129900 }],
  subtotal_paise: 129900,
  discount_paise: 0,
  shipping_paise: 9900,
  total_paise: 139800,
  coupon_code: null,
});

// ── fake D1 ───────────────────────────────────────────────────────
function makeDB({ users = [USER], invoices = [], businesses = null } = {}) {
  const db = {
    users: users.map((u) => ({ ...u })),
    invoices: invoices.map((i) => ({ ...i })),
    line_items: [],
    // One business per user, built from that user's biz_* fields — exactly what
    // migration 0010 does to existing accounts. Seeding it this way keeps the
    // assertions below meaningful: the shop path now reads the header off a
    // business row, and this is the row it would read in production.
    businesses: businesses || users.map((u, i) => ({
      id: `b-${i + 1}`, user_id: u.id, is_default: 1, created_at: 1,
      biz_name: u.biz_name || "", biz_email: u.biz_email || "", biz_addr: u.biz_addr || "",
      biz_phone: u.biz_phone || "", biz_gst: u.biz_gst || "", biz_pay: u.biz_pay || "",
      biz_logo: u.biz_logo || "", qr_url: "", qr_caption: "",
    })),
  };

  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (s.startsWith("SELECT * FROM users WHERE lower(email)=?")) {
      const u = db.users.find((x) => x.email.toLowerCase() === String(a[0]).toLowerCase());
      return { first: u || null };
    }
    if (s.startsWith("SELECT id, number, total FROM invoices WHERE source_ref=?")
        || s.startsWith("SELECT id, number FROM invoices WHERE source_ref=?")) {
      const i = db.invoices.find((x) => x.source_ref === a[0]);
      return { first: i || null };
    }
    if (s.startsWith("SELECT * FROM businesses WHERE user_id=?")) {
      const rows = db.businesses
        .filter((x) => x.user_id === a[0])
        .sort((x, y) => (y.is_default - x.is_default) || (x.created_at - y.created_at));
      return { first: rows[0] || null, results: rows };
    }
    if (s.startsWith("SELECT * FROM businesses WHERE id=? AND user_id=?")) {
      return { first: db.businesses.find((x) => x.id === a[0] && x.user_id === a[1]) || null };
    }
    if (s.startsWith("INSERT INTO invoices")) {
      const [id, user_id, business_id, number, issue_date, due_date, currency, tax_mode, tax_rate,
             discount_pct, shipping, shipping_mode, round_off, status, notes,
             client_name, client_email, client_addr, client_gst, client_phone, total,
             source, source_ref] = a;
      // Emulate the partial UNIQUE index on source_ref, or the idempotency test
      // would pass against a fake that is more permissive than the database.
      // __noUnique lets one test switch it off, to prove the application-level
      // pre-check stands up on its own rather than being carried by the index.
      if (!db.__noUnique && source_ref && db.invoices.some((x) => x.source_ref === source_ref)) {
        throw new Error("UNIQUE constraint failed: invoices.source_ref");
      }
      db.invoices.push({ id, user_id, business_id, number, issue_date, due_date, currency,
        tax_mode, tax_rate, discount_pct, shipping, shipping_mode, round_off, status, notes,
        client_name, client_email, client_addr, client_gst, client_phone, total, source, source_ref });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO line_items")) {
      const [id, invoice_id, pos, description, qty, rate] = a;
      db.line_items.push({ id, invoice_id, pos, description, qty, rate });
      return { meta: { changes: 1 } };
    }
    // ── the WhatsApp paths ──
    if (s.startsWith("UPDATE invoices SET share_token=COALESCE(share_token, ?)")) {
      const i = db.invoices.find((x) => x.id === a[2]);
      if (i) { i.share_token = i.share_token || a[0]; i.updated_at = a[1]; }
      return { meta: { changes: i ? 1 : 0 } };
    }
    if (s.startsWith("SELECT share_token FROM invoices WHERE id=?")) {
      const i = db.invoices.find((x) => x.id === a[0]);
      return { first: i ? { share_token: i.share_token || null } : null };
    }
    if (s.startsWith("UPDATE invoices SET wa_message_id=?")) {
      const i = db.invoices.find((x) => x.id === a[3]);
      if (i) { i.wa_message_id = a[0]; i.wa_sent_at = a[1]; }
      return { meta: { changes: i ? 1 : 0 } };
    }
    // Matched on the FULL scoping clause. A loosened query in src must land on the
    // catch-all below and blow up, not be quietly answered by a laxer matcher.
    if (s.startsWith("SELECT * FROM invoices WHERE source_ref=? AND source='shop' AND user_id=?")) {
      return { first: db.invoices.find((x) => x.source_ref === a[0] && x.source === "shop" && x.user_id === a[1]) || null };
    }
    if (s.startsWith("UPDATE invoices SET courier=?, tracking_id=?, shipped_at=COALESCE(shipped_at, ?)")) {
      const i = db.invoices.find((x) => x.id === a[4]);
      if (i) { i.courier = a[0]; i.tracking_id = a[1]; i.shipped_at = i.shipped_at || a[2]; }
      return { meta: { changes: i ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE invoices SET wa_shipped_message_id=?")) {
      const i = db.invoices.find((x) => x.id === a[3]);
      if (i) { i.wa_shipped_message_id = a[0]; i.wa_shipped_at = a[1]; }
      return { meta: { changes: i ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE invoices SET delivered_at=COALESCE(delivered_at, ?)")) {
      const i = db.invoices.find((x) => x.id === a[2]);
      if (i) { i.delivered_at = i.delivered_at || a[0]; i.track_status = "delivered"; }
      return { meta: { changes: i ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE invoices SET wa_delivered_message_id=?")) {
      const i = db.invoices.find((x) => x.id === a[3]);
      if (i) { i.wa_delivered_message_id = a[0]; i.wa_delivered_at = a[1]; }
      return { meta: { changes: i ? 1 : 0 } };
    }
    throw new Error("unhandled SQL in fake D1: " + s.slice(0, 90));
  };

  return {
    _db: db,
    prepare(sql) {
      // bind() returns a NEW statement, as real D1 does — it does not mutate and
      // return itself.
      //
      // This matters, and getting it wrong hid a real difference: both this file
      // and src/index.js build a batch by calling .bind() repeatedly on ONE
      // prepared statement and collecting the results. Against a fake that
      // returns `this`, every element of that array is the same object carrying
      // the last row's arguments, so all the line items came out identical. The
      // production code was fine; the fake was lying.
      const make = (args) => ({
        bind: (...a) => make(a),
        async all() { return { results: run(sql, args).results || [] }; },
        async first() { return run(sql, args).first ?? null; },
        async run() { return run(sql, args); },
      });
      return make([]);
    },
    async batch(stmts) { for (const s of stmts) await s.run(); },
  };
}

// Captures outbound email instead of calling Resend.
function envWith(opts = {}, over = {}) {
  const sent = [];
  const wa = [];
  const env = { ...ENV, ...over, DB: makeDB(opts), _sent: sent, _wa: wa };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const host = new URL(u).hostname;
    if (host === "api.resend.com") {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "email-" + sent.length }), { status: 200 });
    }
    // Meta's Cloud API. Captures the exact template payload; a test can make it
    // refuse by setting env._waFail to Meta's error message.
    if (host === "graph.facebook.com") {
      const body = JSON.parse(init.body);
      wa.push({ url: u, body, auth: init.headers?.Authorization || "" });
      if (env._waFail) {
        return new Response(JSON.stringify({ error: { message: env._waFail, code: 132012 } }), { status: 400 });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.stub" + wa.length }] }), { status: 200 });
    }
    throw new Error("unexpected fetch to " + u);
  };
  return env;
}

// WhatsApp switched on, the way production has it. Kept separate so every
// existing test still runs with it OFF and proves the feature is opt-in by config.
const WA = { WA_PHONE_NUMBER_ID: "1234567890", WA_ACCESS_TOKEN: "EAAtest", APP_BASE_URL: "https://invoicer.aswincloud.com" };

async function signedShipment(bodyObj, { secret = SECRET, signature = null } = {}) {
  const raw = JSON.stringify(bodyObj);
  return new Request("https://invoicer/api/ingest/shipment", {
    method: "POST", body: raw,
    headers: { "x-shop-signature": signature ?? (await hmacHex(raw, secret)) },
  });
}

async function signedRequest(bodyObj, { secret = SECRET, signature = null } = {}) {
  const raw = JSON.stringify(bodyObj);
  return new Request("https://invoicer/api/ingest/order", {
    method: "POST", body: raw,
    headers: { "x-shop-signature": signature ?? (await hmacHex(raw, secret)) },
  });
}

// ── THE INVARIANT ─────────────────────────────────────────────────
//
// The customer has already paid. Whatever else this code does, the invoice total
// must equal the amount charged, to the paisa.
section("the invoice total equals the amount actually paid");
{
  const cases = [
    ["plain order",                 { }],
    ["with shipping",               { shipping_paise: 9900 }],
    ["free shipping",               { shipping_paise: 0, total_paise: 129900 }],
    ["multiple items", {
      items: [{ name: "Dragon", qty: 2, price_paise: 129900 },
              { name: "Keychain", qty: 3, price_paise: 9900 }],
      subtotal_paise: 289500, shipping_paise: 0, total_paise: 289500 }],
    // The case that motivates the negative-line-item design: ₹300 off ₹1,299 is
    // 23.0946...%, which no percentage field can hold exactly.
    ["awkward discount (₹300 off ₹1,299)", {
      discount_paise: 30000, coupon_code: "CHAT-ABC123",
      shipping_paise: 9900, total_paise: 109800 }],
    ["discount larger than shipping", {
      discount_paise: 50000, coupon_code: "FLAT500",
      shipping_paise: 9900, total_paise: 89800 }],
    ["discount clamped to subtotal", {
      items: [{ name: "Keychain", qty: 1, price_paise: 9900 }],
      subtotal_paise: 9900, discount_paise: 9900, coupon_code: "FREE",
      shipping_paise: 9900, total_paise: 9900 }],
    ["odd paise (a 1/3 split)", {
      items: [{ name: "Odd", qty: 3, price_paise: 33333 }],
      subtotal_paise: 99999, shipping_paise: 0, total_paise: 99999 }],
  ];

  for (const [label, over] of cases) {
    const order = { ...ORDER(), ...over };
    const r = buildInvoice(order, order.receipt, USER);
    if (r.error) { ok(label, false, r.error); continue; }
    const renderedPaise = Math.round(r.total * 100);
    ok(`${label}: ₹${(order.total_paise / 100).toFixed(2)}`,
       renderedPaise === order.total_paise,
       `invoice ${renderedPaise} vs paid ${order.total_paise}`);
  }
}

section("nothing recomputes the price");
{
  const order = { ...ORDER(), discount_paise: 30000, coupon_code: "SAVE", total_paise: 109800 };
  const { inv, items } = buildInvoice(order, order.receipt, USER);
  ok("no tax mode", inv.tax_mode === "none", inv.tax_mode);
  ok("no tax rate", inv.tax_rate === 0);
  ok("no discount percentage", inv.discount_pct === 0);
  ok("no round-off", inv.round_off === 0);

  const t = computeTotals(inv, items);
  ok("no tax rows rendered", t.taxRows.length === 0, JSON.stringify(t.taxRows));
  ok("no round-off row", Math.abs(t.round) < 0.005, String(t.round));

  // The discount is a line item, not a percentage — and it names the code.
  const disc = items.find((i) => i.rate < 0);
  ok("discount is a negative line item", Boolean(disc));
  ok("discount is exact", Math.round(disc.rate * 100) === -30000, String(disc.rate));
  ok("discount names the code", /SAVE/.test(disc.description), disc.description);
}

section("a mismatch is refused rather than issued");
{
  // If the shop ever sends a total that disagrees with its own line items, the
  // right answer is to refuse. Issuing a document that contradicts the bank
  // statement is worse than issuing nothing.
  const order = { ...ORDER(), total_paise: 999999 };
  const r = buildInvoice(order, order.receipt, USER);
  ok("refuses to issue", Boolean(r.error), JSON.stringify(r).slice(0, 80));
  ok("says why", /does not match/.test(r.error || ""), r.error);
}

// ── the document itself ───────────────────────────────────────────
section("the invoice reads correctly");
{
  const order = { ...ORDER(), discount_paise: 30000, coupon_code: "CHAT-ABC123",
                  total_paise: 109800 };
  const { inv, items, total } = buildInvoice(order, order.receipt, USER);

  ok("number derives from the receipt", inv.number === "AP-2026-1A2B3C4D", inv.number);
  ok("marked PAID", inv.status === "PAID");
  ok("no due date on a settled invoice", inv.due_date === "");
  ok("issue date is the payment date", inv.issue_date === "2026-08-06", inv.issue_date);
  ok("notes cite the order", inv.notes.includes("AP-1a2b3c4d"), inv.notes);
  ok("billed to the customer", inv.client_email === "buyer@example.com");
  ok("address is assembled", /Chennai/.test(inv.client_addr) && /600001/.test(inv.client_addr),
     inv.client_addr);

  const html = renderInvoiceEmail({ ...inv, total, ...USER }, items);
  ok("renders the business name", html.includes("AswinPrints"));
  ok("renders the promo code", html.includes("CHAT-ABC123"));
  ok("renders the paid total", html.includes("1,098.00"), "expected ₹1,098.00");
  ok("no CGST/SGST rows", !/CGST|SGST/.test(html));

  // "Taxable value" is the base a tax was computed on. With no tax it is the
  // subtotal restated under a name that implies a tax exists — and on this
  // invoice it printed the same ₹1,098 as the total, one line above it, which
  // reads like a mistake. Caught by looking at the rendered invoice rather than
  // at the numbers.
  ok("no 'Taxable value' row on a no-tax invoice", !/Taxable value/.test(html));
  ok("the total appears once, not twice",
     (html.match(/1,098\.00/g) || []).length === 1,
     String((html.match(/1,098\.00/g) || []).length));

  // ...but the row must survive for invoices that DO carry tax, or removing it
  // would be a regression for every hand-made GST invoice.
  const gst = renderInvoiceEmail(
    { ...inv, tax_mode: "gst", tax_rate: 18, total: 1295, ...USER }, items);
  ok("'Taxable value' survives on a GST invoice", /Taxable value/.test(gst));
  ok("CGST/SGST still render when tax applies", /CGST/.test(gst) && /SGST/.test(gst));
}

// ── the logo ──────────────────────────────────────────────────────
//
// Reported from a real invoice: the logo arrived as a broken image. It is stored
// as a data: URI (the Settings page uses readAsDataURL), which renders fine in a
// browser — so the on-screen invoice and the PDF always looked right — but Gmail,
// Outlook and Apple Mail all strip data: images.
//
// Nothing here asserted the logo at all, which is why it shipped. These are the
// checks that would have caught it.
section("the logo survives the trip to an inbox");
{
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const l = logoAttachment(png);
  ok("a data: logo becomes an attachment", Boolean(l));
  ok("referenced by cid, not data:", l.src.startsWith("cid:"), l.src);
  ok("attachment carries a content_id", Boolean(l.attachment.content_id));
  ok("cid in src matches the attachment", l.src === `cid:${l.attachment.content_id}`);
  ok("content is raw base64, no data: prefix",
     !l.attachment.content.startsWith("data:"), l.attachment.content.slice(0, 12));
  ok("content type preserved", l.attachment.content_type === "image/png");
  ok("filename has the right extension", l.attachment.filename === "logo.png");

  const jpg = logoAttachment("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  ok("jpeg is handled", jpg?.attachment.filename === "logo.jpg", jpg?.attachment.filename);
}
{
  // Anything that is not a usable image returns null, and the template falls back
  // to the initial badge rather than rendering a broken <img>.
  for (const [label, v] of [
    ["empty", ""], ["null", null], ["a plain URL", "https://example.com/logo.png"],
    ["a non-image data URI", "data:text/html;base64,PHNjcmlwdD4="],
    ["malformed base64", "data:image/png;base64,not base64!"],
    ["an oversized payload", "data:image/png;base64," + "A".repeat(2_000_001)],
  ]) ok(`${label} → no attachment`, logoAttachment(v) === null);
}
{
  // THE assertion. A data: URI must never reach the rendered email.
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const l = logoAttachment(png);
  const inv = { currency: "₹", tax_mode: "none", tax_rate: 0, discount_pct: 0,
                round_off: 0, shipping: 0, total: 100, biz_name: "AswinPrints",
                biz_logo: png };
  const items = [{ description: "Thing", qty: 1, rate: 100 }];

  const email = renderInvoiceEmail(inv, items, { logoSrc: l.src });
  ok("no data: image in the email HTML", !/src="data:/.test(email));
  ok("the cid reference is there", email.includes(`src="cid:${l.attachment.content_id}"`));
  ok("the business name still renders", email.includes("AswinPrints"));

  // With no logo at all, the initial badge renders and there is no <img> to break.
  const noLogo = renderInvoiceEmail({ ...inv, biz_logo: "" }, items, { logoSrc: "" });
  ok("no logo → no <img> tag at all", !/<img/.test(noLogo));
  ok("no logo → initial badge instead", noLogo.includes(">A<"));

  // The browser path is unchanged: called without an override, the data: URI is
  // still used, so the on-screen invoice and the PDF keep working.
  const browser = renderInvoiceEmail(inv, items);
  ok("browser rendering still uses the data: URI", browser.includes('src="data:image/png'));
}
{
  // End to end through the handler: the sent email must carry the attachment.
  const env = envWith({ users: [{ ...USER, biz_logo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" }] });
  await ingestOrder(await signedRequest(ORDER()), env);
  const mail = env._sent[0];
  // Two attachments now: the logo (inline, by CID) and the PDF copy.
  ok("the email carries attachments", Array.isArray(mail.attachments) && mail.attachments.length === 2,
     String(mail.attachments?.length));
  const logoAtt = mail.attachments.find((a) => a.content_id === "logo@invoicer");
  ok("one is the logo", Boolean(logoAtt));
  ok("and the HTML points at it", mail.html.includes("cid:logo@invoicer"));
  ok("and carries no data: image", !/src="data:/.test(mail.html));

  // The logo must be INLINE and the PDF must NOT be — a logo listed as a
  // downloadable file, or a PDF that never shows as one, would both be wrong.
  const pdfAtt = mail.attachments.find((a) => a.filename.endsWith(".pdf"));
  ok("the other is the PDF", Boolean(pdfAtt), JSON.stringify(mail.attachments.map((a) => a.filename)));
  ok("the PDF has no content_id (not inline)", pdfAtt.content_id === undefined);
}
{
  // No logo configured: no attachment key at all, rather than an empty array.
  const env = envWith({ users: [{ ...USER, biz_logo: "" }] });
  await ingestOrder(await signedRequest(ORDER()), env);
  const mail = env._sent[0];
  // No logo, but the PDF is always attached — so exactly one attachment, and it
  // must be the PDF rather than an empty logo slot.
  ok("no logo → only the PDF is attached", mail.attachments?.length === 1,
     String(mail.attachments?.length));
  ok("and it is the PDF", mail.attachments[0].filename.endsWith(".pdf"));
  ok("and the email still goes out", Boolean(mail.html));
}

// ── the PDF attachment ────────────────────────────────────────────
//
// test/pdf.mjs covers the document itself. What matters here is that it reaches
// the customer, is named usefully, and — most importantly — that a failure to
// build it never costs them the invoice.
section("the PDF reaches the customer");
{
  const env = envWith();
  await ingestOrder(await signedRequest(ORDER()), env);
  const pdf = env._sent[0].attachments.find((a) => a.filename.endsWith(".pdf"));

  ok("named after the invoice", pdf.filename === "AP-2026-1A2B3C4D.pdf", pdf.filename);
  ok("declared as a PDF", pdf.content_type === "application/pdf");
  ok("content is base64", /^[A-Za-z0-9+/]+=*$/.test(pdf.content));

  const bytes = Buffer.from(pdf.content, "base64");
  ok("is a real PDF file", bytes.subarray(0, 5).toString() === "%PDF-", bytes.subarray(0, 8).toString());
  ok("is complete", bytes.toString("latin1").trimEnd().endsWith("%%EOF"));

  // The number on the attachment must match the number in the email body, and
  // both must match what was charged. A PDF that disagrees with the email it
  // arrived with is worse than no PDF.
  //
  // ORDER() is ₹1,299 + ₹99 shipping = ₹1,398, with no discount — read from the
  // fixture rather than hardcoded, so this cannot drift out of step with it.
  const expected = (ORDER().total_paise / 100).toLocaleString("en-IN",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ok(`the PDF states the amount charged (${expected})`,
     bytes.toString("latin1").includes(expected));
  ok("the email body agrees", env._sent[0].html.includes(expected));

  ok("the email mentions the attachment", /PDF copy is attached/i.test(env._sent[0].text));
}
{
  // A layout bug in the generator must not cost the customer their invoice —
  // the email body IS the invoice. Simulate a throw from the PDF path.
  const env = envWith();
  const items = ORDER().items;
  // A description that is not a string at all; the generator must either cope or
  // throw, and either way the email must go.
  const weird = { ...ORDER(), items: [{ name: { nope: true }, qty: 1, price_paise: 129900 }] };
  const res = await ingestOrder(await signedRequest(weird), env);
  ok("a hostile item does not block the invoice", res.status === 200, String(res.status));
  ok("and the email is still sent", env._sent.length === 1);
}

// ── idempotency ───────────────────────────────────────────────────
//
// Razorpay redelivers webhooks. A second invoice for one payment means a second
// email to the customer and a duplicate document in the books.
section("a redelivered order does not invoice twice");
{
  const env = envWith();
  const first = await ingestOrder(await signedRequest(ORDER()), env);
  const fb = await first.json();
  ok("first call creates an invoice", first.status === 200 && fb.ok && !fb.duplicate);
  ok("one invoice row", env.DB._db.invoices.length === 1);
  ok("one email sent", env._sent.length === 1);

  const second = await ingestOrder(await signedRequest(ORDER()), env);
  const sb = await second.json();
  ok("second call is flagged duplicate", sb.duplicate === true, JSON.stringify(sb));
  ok("still one invoice row", env.DB._db.invoices.length === 1,
     String(env.DB._db.invoices.length));
  ok("still one email", env._sent.length === 1, String(env._sent.length));
  ok("returns the original invoice", sb.id === fb.id);
}
{
  // The pre-check and the UNIQUE index each stop a duplicate on their own, which
  // is the point — but it also means removing either one leaves the tests green,
  // since the other covers for it. Found by deleting the pre-check and seeing 0
  // failures. So each is asserted against a database where the OTHER cannot help.
  //
  // Index removed: only the pre-check can stop the second insert.
  const env = envWith();
  env.DB._db.__noUnique = true;   // fake stops emulating the index (see makeDB)
  await ingestOrder(await signedRequest(ORDER()), env);
  const second = await ingestOrder(await signedRequest(ORDER()), env);
  ok("pre-check alone stops a duplicate", env.DB._db.invoices.length === 1,
     String(env.DB._db.invoices.length));
  ok("and sends no second email", env._sent.length === 1, String(env._sent.length));
  ok("and still reports duplicate", (await second.json()).duplicate === true);
}
{
  // Pre-check bypassed: only the UNIQUE index can stop it. This is the real
  // concurrent-delivery case — two webhooks in flight, both seeing no row.
  const env = envWith();
  await ingestOrder(await signedRequest(ORDER()), env);

  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => (/SELECT id, number, total FROM invoices/.test(sql)
    ? { bind() { return this; }, async first() { return null; },
        async all() { return { results: [] }; }, async run() { return {}; } }
    : realPrepare(sql));

  const res = await ingestOrder(await signedRequest(ORDER()), env);
  ok("the UNIQUE index alone stops a duplicate", env.DB._db.invoices.length === 1,
     String(env.DB._db.invoices.length));
  ok("and it is not an error", res.status === 200, String(res.status));
  ok("and no second email", env._sent.length === 1, String(env._sent.length));
}
{
  // Simulate the race the index exists for: a row appearing between the check
  // and the insert.
  const env = envWith();
  const realPrepare = env.DB.prepare.bind(env.DB);
  let checked = false;
  env.DB.prepare = (sql) => {
    if (!checked && /SELECT id, number, total FROM invoices/.test(sql)) {
      checked = true;
      // Another delivery lands right now.
      env.DB._db.invoices.push({ id: "raced", number: "AP-2026-1A2B3C4D",
                                 source_ref: "AP-1a2b3c4d", total: 1398 });
      // ...but this request's check already saw nothing.
      return { bind() { return this; }, async first() { return null; },
               async all() { return { results: [] }; }, async run() { return {}; } };
    }
    return realPrepare(sql);
  };
  const res = await ingestOrder(await signedRequest(ORDER()), env);
  const body = await res.json();
  ok("a lost race is handled, not crashed", res.status === 200, String(res.status));
  ok("and reports the winner", body.duplicate === true, JSON.stringify(body));
  ok("no duplicate row written", env.DB._db.invoices.length === 1);
}

// ── auth ──────────────────────────────────────────────────────────
//
// Without this the endpoint emails invoices from Aswin's business to anyone who
// finds the URL.
section("HMAC auth");
{
  const env = envWith();
  const r = await ingestOrder(await signedRequest(ORDER()), env);
  ok("a correctly signed request is accepted", r.status === 200, String(r.status));
}
{
  const env = envWith();
  const req = new Request("https://invoicer/api/ingest/order", {
    method: "POST", body: JSON.stringify(ORDER()),
  });
  const r = await ingestOrder(req, env);
  ok("no signature → 401", r.status === 401, String(r.status));
  ok("and writes no invoice", env.DB._db.invoices.length === 0);
  ok("and sends no email", env._sent.length === 0);
}
{
  const env = envWith();
  const r = await ingestOrder(await signedRequest(ORDER(), { secret: "wrong" }), env);
  ok("wrong secret → 401", r.status === 401, String(r.status));
  ok("and writes no invoice", env.DB._db.invoices.length === 0);
}
{
  // Signature valid for a different body — verifying a signature but acting on
  // swapped content is the classic version of this mistake.
  const env = envWith();
  const honest = JSON.stringify(ORDER());
  const sig = await hmacHex(honest, SECRET);
  const tampered = JSON.stringify({ ...ORDER(), customer: { ...ORDER().customer,
                                    email: "attacker@evil.com" } });
  const req = new Request("https://invoicer/api/ingest/order", {
    method: "POST", body: tampered, headers: { "x-shop-signature": sig },
  });
  const r = await ingestOrder(req, env);
  ok("body swapped after signing → 401", r.status === 401, String(r.status));
  ok("and emails nobody", env._sent.length === 0);
}
{
  const env = envWith();
  const old = await ingestOrder(
    await signedRequest({ ...ORDER(), ts: Date.now() - 10 * 60 * 1000 }), env);
  ok("a 10-minute-old request → 401", old.status === 401, String(old.status));

  const future = await ingestOrder(
    await signedRequest({ ...ORDER(), ts: Date.now() + 10 * 60 * 1000 }), env);
  ok("a far-future timestamp → 401", future.status === 401, String(future.status));

  const drift = await ingestOrder(
    await signedRequest({ ...ORDER(), ts: Date.now() - 60 * 1000 }), env);
  ok("ordinary clock drift is tolerated", drift.status === 200, String(drift.status));
}
{
  const env = envWith({}, { SHOP_INGEST_SECRET: "" });
  const r = await ingestOrder(await signedRequest(ORDER()), env);
  ok("missing secret fails CLOSED", r.status === 503, String(r.status));
  ok("and writes nothing", env.DB._db.invoices.length === 0);
}

// ── config ────────────────────────────────────────────────────────
section("kill switch and configuration");
{
  const env = envWith({}, { SHOP_INGEST_ENABLED: "false" });
  const r = await ingestOrder(await signedRequest(ORDER()), env);
  ok("disabled → 503", r.status === 503, String(r.status));
  ok("and writes nothing", env.DB._db.invoices.length === 0);
  ok("and emails nobody", env._sent.length === 0);
}
{
  // Absent must mean OFF. A fresh environment picking up this code should not
  // start emailing invoices because a var was forgotten.
  const env = envWith({}, { SHOP_INGEST_ENABLED: undefined });
  const r = await ingestOrder(await signedRequest(ORDER()), env);
  ok("absent flag → 503 (opt-in, not opt-out)", r.status === 503, String(r.status));
}
{
  // No Invoicer account for the configured owner: the invoice would go out
  // headed "Your Business", which is worse than not sending it.
  const env = envWith({ users: [] });
  const r = await ingestOrder(await signedRequest(ORDER()), env);
  ok("no owner account → 503, not a headless invoice", r.status === 503, String(r.status));
  ok("and writes nothing", env.DB._db.invoices.length === 0);
}
{
  // The issuer comes from config, never the request — otherwise the caller picks
  // whose business name appears on the document.
  const env = envWith();
  await ingestOrder(await signedRequest({ ...ORDER(), user_id: "someone-else",
                                          biz_name: "Not Aswin" }), env);
  const row = env.DB._db.invoices[0];
  ok("issuer is not taken from the request", row.user_id === "u-1", row.user_id);
}

// ── tampering ─────────────────────────────────────────────────────
section("a signed body still cannot forge the amount");
{
  // The shop holds the secret, so this is not an attacker scenario — it is a
  // guard against a bug in the shop, or a future caller, silently issuing an
  // invoice for the wrong money.
  const env = envWith();
  const r = await ingestOrder(await signedRequest({
    ...ORDER(),
    total_paise: 1,               // claims ₹0.01 was paid
  }), env);
  ok("an internally inconsistent order is refused", r.status === 400, String(r.status));
  ok("and writes nothing", env.DB._db.invoices.length === 0);
  ok("and emails nobody", env._sent.length === 0);
}
{
  const env = envWith();
  const r = await ingestOrder(await signedRequest({ ...ORDER(), items: [] }), env);
  ok("an order with no items is refused", r.status === 400, String(r.status));
}
{
  const env = envWith();
  const r = await ingestOrder(await signedRequest({
    ...ORDER(), customer: { ...ORDER().customer, email: "" } }), env);
  ok("an order with no customer email is refused", r.status === 400, String(r.status));
}

// ── line items ────────────────────────────────────────────────────
section("line items reach the database");
{
  const env = envWith();
  await ingestOrder(await signedRequest({
    ...ORDER(),
    items: [{ name: "Dragon", qty: 2, price_paise: 129900 },
            { name: "Keychain", qty: 1, price_paise: 9900 }],
    subtotal_paise: 269700, discount_paise: 30000, coupon_code: "SAVE300",
    shipping_paise: 0, total_paise: 239700,
  }), env);

  const li = env.DB._db.line_items;
  ok("every item is written", li.length === 3, String(li.length));
  ok("rates are rupees, not paise", li[0].rate === 1299, String(li[0].rate));
  ok("quantities survive", li[0].qty === 2, String(li[0].qty));
  ok("the discount line is last", li[2].rate === -300, String(li[2].rate));
  ok("positions are ordered", li.map((x) => x.pos).join(",") === "0,1,2");
}


// ══ WhatsApp ══════════════════════════════════════════════════════════════════
//
// The templates, the token and the PDF all live here, so the shop's WhatsApp
// messages are sent from here: the confirmation the moment a shop order is
// invoiced, shipped and delivered when the shop dashboard says so. Every send
// is stubbed at graph.facebook.com and the payload is asserted component by
// component — Meta only checks the count, so params in the wrong order go out
// as nonsense.

section("whatsapp: the confirmation goes out when a shop order is invoiced");
{
  const env = envWith({}, WA);
  const res = await ingestOrder(await signedRequest(ORDER()), env);
  const b = await res.json();
  ok("ingest still succeeds", res.status === 200 && b.ok === true, JSON.stringify(b));
  ok("reports the WhatsApp as sent", b.whatsapp === "sent", b.whatsapp);
  ok("one message to Meta", env._wa.length === 1, String(env._wa.length));
  const msg = env._wa[0]?.body;
  ok("to the customer's mobile as E.164 digits", msg?.to === "919876543210", msg?.to);
  ok("uses the confirmation template", msg?.template?.name === "order_confirmed_new", msg?.template?.name);
  const header = msg?.template?.components?.find((c) => c.type === "header");
  ok("carries the DOCUMENT header Meta demands", header?.parameters?.[0]?.type === "document", JSON.stringify(header));
  ok("the document is the invoice PDF at /i/<token>.pdf",
     /^https:\/\/invoicer\.aswincloud\.com\/i\/[A-Za-z0-9_-]+\.pdf$/.test(header?.parameters?.[0]?.document?.link || ""),
     header?.parameters?.[0]?.document?.link);
  const bodyC = msg?.template?.components?.find((c) => c.type === "body");
  ok("body params: customer, order number, business — in that order",
     JSON.stringify(bodyC?.parameters?.map((p) => p.text)) === JSON.stringify(["Test Buyer", "AP-2026-1A2B3C4D", "AswinPrints"]),
     JSON.stringify(bodyC?.parameters));
  const inv = env.DB._db.invoices[0];
  ok("the phone is stored on the invoice as E.164", inv.client_phone === "919876543210", inv.client_phone);
  ok("the send is recorded on the row", inv.wa_message_id === "wamid.stub1" && typeof inv.wa_sent_at === "number");
  ok("a share token was minted for the PDF", typeof inv.share_token === "string" && inv.share_token.length > 8);
  ok("the email still went too", env._sent.length === 1);
}

section("whatsapp: nothing goes out when it cannot be sure of the number");
{
  for (const [label, phone] of [["blank", ""], ["landline-shaped", "0413 222 3344"], ["too short", "98765"], ["letters", "call me"]]) {
    const env = envWith({}, WA);
    const order = ORDER(); order.customer.phone = phone;
    const b = await (await ingestOrder(await signedRequest(order), env)).json();
    ok(`${label} phone → skipped, invoice still raised`, b.ok === true && b.whatsapp === "skipped" && env._wa.length === 0,
       `whatsapp=${b.whatsapp} sends=${env._wa.length}`);
    ok(`${label} phone → stored as empty, never as typed`, env.DB._db.invoices[0].client_phone === "");
  }
}

section("whatsapp: opt-in by config — without WA_* nothing is attempted");
{
  const env = envWith();
  const b = await (await ingestOrder(await signedRequest(ORDER()), env)).json();
  ok("skipped when not configured", b.whatsapp === "skipped", b.whatsapp);
  ok("no call to Meta", env._wa.length === 0);
  ok("the phone is still stored for later", env.DB._db.invoices[0].client_phone === "919876543210");
}

section("whatsapp: Meta refusing does not fail the ingest");
{
  const env = envWith({}, WA);
  env._waFail = "(#132012) Parameter format does not match format in the created template";
  const res = await ingestOrder(await signedRequest(ORDER()), env);
  const b = await res.json();
  ok("ingest is still 200 ok", res.status === 200 && b.ok === true);
  ok("reports the WhatsApp as failed", b.whatsapp === "failed", b.whatsapp);
  ok("invoice row exists", env.DB._db.invoices.length === 1);
  ok("email still sent", env._sent.length === 1);
  ok("no message id recorded for a refused send", !env.DB._db.invoices[0].wa_message_id);
}

section("whatsapp: a redelivered webhook sends ONE confirmation");
{
  const env = envWith({}, WA);
  await ingestOrder(await signedRequest(ORDER()), env);
  const second = await (await ingestOrder(await signedRequest(ORDER()), env)).json();
  ok("second call is the duplicate branch", second.duplicate === true);
  ok("exactly one WhatsApp went out", env._wa.length === 1, String(env._wa.length));
}

async function invoicedEnv(over = {}) {
  const env = envWith({}, { ...WA, ...over });
  await ingestOrder(await signedRequest(ORDER()), env);
  env._wa.length = 0;
  return env;
}
const SHIP = (over = {}) => ({ ts: Date.now(), receipt: "AP-1a2b3c4d", kind: "shipped", courier: "Blue Dart", tracking: "BD 1234 5678", ...over });

section("shipment: the same door as ingest — signature, replay, kill switch");
{
  const env = await invoicedEnv();
  ok("no signature → 401",
     (await ingestShipment(new Request("https://invoicer/api/ingest/shipment", { method: "POST", body: JSON.stringify(SHIP()) }), env)).status === 401);
  ok("wrong secret → 401", (await ingestShipment(await signedShipment(SHIP(), { secret: "wrong" }), env)).status === 401);
  ok("stale timestamp → 401", (await ingestShipment(await signedShipment(SHIP({ ts: Date.now() - 10 * 60 * 1000 })), env)).status === 401);
  ok("kill switch → 503", (await ingestShipment(await signedShipment(SHIP()), { ...env, SHOP_INGEST_ENABLED: "false" })).status === 503);
  ok("unknown kind → 400", (await ingestShipment(await signedShipment(SHIP({ kind: "teleported" })), env)).status === 400);
  ok("unknown receipt → 404", (await ingestShipment(await signedShipment(SHIP({ receipt: "AP-nope0000" })), env)).status === 404);
  ok("none of those sent anything", env._wa.length === 0, String(env._wa.length));
}

section("shipment: shipped sends the tracking message and records the shipment");
{
  const env = await invoicedEnv();
  const res = await ingestShipment(await signedShipment(SHIP()), env);
  const b = await res.json();
  ok("200 and sent", res.status === 200 && b.whatsapp === "sent", JSON.stringify(b));
  ok("ShipTrack knows Blue Dart, so the button is live", b.tracked === true);
  const msg = env._wa[0]?.body;
  ok("uses the shipped template", msg?.template?.name === "order_shipped_link", msg?.template?.name);
  const bodyC = msg?.template?.components?.find((c) => c.type === "body");
  ok("body: customer, order, business, courier NAME, awb",
     JSON.stringify(bodyC?.parameters?.map((p) => p.text)) === JSON.stringify(["Test Buyer", "AP-2026-1A2B3C4D", "AswinPrints", "Blue Dart", "BD12345678"]),
     JSON.stringify(bodyC?.parameters));
  const btn = msg?.template?.components?.find((c) => c.type === "button");
  ok("button suffix is <carrier>/<awb> under ShipTrack's fixed prefix", btn?.parameters?.[0]?.text === "bluedart/BD12345678", btn?.parameters?.[0]?.text);
  const inv = env.DB._db.invoices[0];
  ok("courier and tracking recorded on the invoice", inv.courier === "bluedart" && inv.tracking_id === "BD12345678", `${inv.courier} ${inv.tracking_id}`);
  ok("shipped_at set", typeof inv.shipped_at === "number");
  ok("the send is recorded", inv.wa_shipped_message_id === "wamid.stub1");
}

section("shipment: a courier ShipTrack cannot track is still named, honestly buttoned");
{
  const env = await invoicedEnv();
  const b = await (await ingestShipment(await signedShipment(SHIP({ courier: "DTDC", tracking: "D456789" })), env)).json();
  ok("still sent", b.whatsapp === "sent", JSON.stringify(b));
  ok("reports the button as not tracked", b.tracked === false);
  const msg = env._wa[0]?.body;
  const bodyC = msg?.template?.components?.find((c) => c.type === "body");
  ok("the body names the courier as typed", bodyC?.parameters?.[3]?.text === "DTDC", bodyC?.parameters?.[3]?.text);
  const btn = msg?.template?.components?.find((c) => c.type === "button");
  ok("the button suffix is other/<awb> — ShipTrack's unknown-carrier page, not a broken link",
     btn?.parameters?.[0]?.text === "other/D456789", btn?.parameters?.[0]?.text);
  ok("the typed courier is what is recorded", env.DB._db.invoices[0].courier === "DTDC");
}

section("shipment: sends at most once per kind — a tracking correction must not re-notify");
{
  const env = await invoicedEnv();
  await ingestShipment(await signedShipment(SHIP()), env);
  const again = await (await ingestShipment(await signedShipment(SHIP({ tracking: "BD99999999" })), env)).json();
  ok("second shipped call is already_sent", again.whatsapp === "already_sent", again.whatsapp);
  ok("exactly one shipped message", env._wa.length === 1, String(env._wa.length));
}

section("shipment: no tracking number → no message (the template needs {{5}})");
{
  const env = await invoicedEnv();
  const b = await (await ingestShipment(await signedShipment(SHIP({ tracking: "" })), env)).json();
  ok("skipped with a reason", b.whatsapp === "skipped" && /tracking/.test(b.why || ""), JSON.stringify(b));
  ok("nothing sent", env._wa.length === 0);
}

section("shipment: delivered");
{
  const env = await invoicedEnv();
  await ingestShipment(await signedShipment(SHIP()), env);
  const b = await (await ingestShipment(await signedShipment(SHIP({ kind: "delivered" })), env)).json();
  ok("delivered sent", b.whatsapp === "sent", JSON.stringify(b));
  ok("uses the delivered template", env._wa[1]?.body?.template?.name === "order_delivered_new");
  const inv = env.DB._db.invoices[0];
  ok("delivered_at set and recorded", typeof inv.delivered_at === "number" && inv.wa_delivered_message_id === "wamid.stub2");
  const again = await (await ingestShipment(await signedShipment(SHIP({ kind: "delivered" })), env)).json();
  ok("a second delivered is already_sent", again.whatsapp === "already_sent" && env._wa.length === 2);
}

section("shipment: scoped to the owner's SHOP invoices — a receipt alone reaches nothing else");
{
  const env = envWith({
    users: [USER, { ...USER, id: "u-2", email: "someone-else@example.com" }],
    invoices: [
      { id: "inv-other", user_id: "u-2", business_id: "b-2", number: "X-1", status: "PAID",
        source: "shop", source_ref: "AP-1a2b3c4d", client_phone: "919999999999", client_name: "Other" },
      { id: "inv-manual", user_id: "u-1", business_id: "b-1", number: "M-1", status: "PAID",
        source: "manual", source_ref: "AP-1a2b3c4d", client_phone: "918888888888", client_name: "Manual" },
    ],
  }, WA);
  const res = await ingestShipment(await signedShipment(SHIP()), env);
  ok("no owner shop invoice → 404, even though two rows match the receipt", res.status === 404, String(res.status));
  ok("nothing was sent to either stranger", env._wa.length === 0, String(env._wa.length));
  ok("neither foreign row was touched",
     !env.DB._db.invoices.find((i) => i.id === "inv-other").shipped_at &&
     !env.DB._db.invoices.find((i) => i.id === "inv-manual").shipped_at);
}

section("shipment: no usable mobile → skipped, never guessed");
{
  const env = envWith({}, WA);
  const order = ORDER(); order.customer.phone = "";
  await ingestOrder(await signedRequest(order), env);
  env._wa.length = 0;
  const b = await (await ingestShipment(await signedShipment(SHIP()), env)).json();
  ok("skipped for want of a number", b.whatsapp === "skipped" && /mobile/.test(b.why || ""), JSON.stringify(b));
  ok("nothing sent", env._wa.length === 0);
}

console.log(`\n  ingest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
