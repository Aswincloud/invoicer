// Shareable invoice links, paid online with Razorpay.
//
// ── The invariant ────────────────────────────────────────────────────────────
//
//   The client is charged EXACTLY the figure the page shows them.
//
// The amount comes from computeTotals(inv, items) — the same call that renders
// the total in the invoice body — and never from the request. A browser that
// posts its own amount is ignored, because it is never read. This mirrors
// priceCart() in the shop ("prices come from D1, this is the whole security
// model") and the transcription rule in ingest.js.
//
// ── Who marks an invoice paid ────────────────────────────────────────────────
//
// The WEBHOOK, and nothing else. The checkout callback is signature-verified and
// worth having — it tells the client instantly that their money arrived — but it
// is delivered by the browser that just paid, so it only records the payment id.
// Razorpay's server-to-server order.paid event is the one that writes PAID.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
//
// There is no login for clients. The share token IS the credential: 32 hex
// characters from randToken(16), unguessable, and unrelated to the invoice id.
// Anyone holding the link can read the invoice and pay it — that is the point of
// the feature — so the token is the only thing standing in for a session, and it
// is never derived from anything the owner exposes elsewhere.

import { json, bad, now, randToken, sendEmail } from "./lib.js";
import { computeTotals, renderInvoiceEmail, esc } from "./invoice-html.js";
import {
  createOrder, paymentsConfigured, publicKeyId,
  verifyCallbackSignature, verifyWebhookSignature,
} from "./razorpay.js";

// randToken(16) renders as 32 hex characters. Validated before it reaches SQL so
// a malformed link is a cheap 404 rather than a query.
const TOKEN_RE = /^[0-9a-f]{32}$/;

// Razorpay settles in INR only. Invoicer supports other currencies, and an
// invoice in dollars must still be viewable — it simply cannot show a Pay
// button, because there is nothing correct to charge.
const PAYABLE_CURRENCY = "₹";

const payEnabled = (env) => String(env.PAY_ENABLED ?? "").toLowerCase() === "true";

// Rupees (REAL, as the invoice stores them) to integer paise (what Razorpay
// charges in). Rounded, never truncated: 0.1 + 0.2 in floats is the class of bug
// that puts an invoice a paisa off, and Razorpay rejects non-integers outright.
const paise = (rupees) => Math.round(Number(rupees || 0) * 100);

// ── loading ──────────────────────────────────────────────────────────────────
//
// The business block lives on the user row, so it is joined here the way
// loadInvoice() in index.js attaches it — one invoice, one render, whichever
// door it came through.
async function loadByToken(env, token) {
  if (!TOKEN_RE.test(String(token || ""))) return null;

  const inv = await env.DB.prepare(
    `SELECT i.*, u.email AS owner_email, u.biz_name, u.biz_email, u.biz_addr,
            u.biz_phone, u.biz_gst, u.biz_pay, u.biz_logo
       FROM invoices i JOIN users u ON u.id = i.user_id
      WHERE i.share_token = ?`
  ).bind(token).first();
  if (!inv) return null;

  const { results } = await env.DB.prepare(
    "SELECT description,qty,rate,pos FROM line_items WHERE invoice_id=? ORDER BY pos"
  ).bind(inv.id).all();

  return { inv, items: results || [] };
}

// Everything that decides whether this invoice can be paid right now, in one
// place, so the page and the order endpoint cannot disagree about it — a button
// that appears but 400s is worse than no button.
function payability(env, inv, total) {
  if (!payEnabled(env)) return { ok: false, why: "Online payment is turned off." };
  if (!paymentsConfigured(env)) return { ok: false, why: "Online payment is not set up." };
  if (String(inv.status || "").toUpperCase() === "PAID") return { ok: false, why: "paid" };
  if ((inv.currency || PAYABLE_CURRENCY) !== PAYABLE_CURRENCY) {
    return { ok: false, why: `Online payment is available for ${PAYABLE_CURRENCY} invoices only.` };
  }
  if (paise(total) < 100) return { ok: false, why: "This invoice is below the ₹1 minimum." };
  return { ok: true };
}

// ── GET /i/:token — the public page ──────────────────────────────────────────
export async function sharePage(env, token) {
  const loaded = await loadByToken(env, token);
  if (!loaded) return notFoundPage();

  const { inv, items } = loaded;
  const t = computeTotals(inv, items);
  const can = payability(env, inv, t.total);
  const isPaid = String(inv.status || "").toUpperCase() === "PAID";

  // The invoice body is renderInvoiceEmail's fragment verbatim. One template
  // across email, PDF and this page means a change to the invoice layout cannot
  // land in two of the three.
  const body = renderInvoiceEmail(inv, items, inv.biz_logo || null);

  const bizName = (inv.biz_name || "Invoicer").trim();
  const amountLabel = `${inv.currency || PAYABLE_CURRENCY} ${Number(t.total).toLocaleString(
    (inv.currency || PAYABLE_CURRENCY) === "₹" ? "en-IN" : "en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const banner = isPaid
    ? `<div class="banner paid">Paid${inv.paid_at ? ` on ${new Date(inv.paid_at).toISOString().slice(0, 10)}` : ""} — thank you.</div>`
    : "";

  // Preview crawlers will not render a data: URI, and the logo is stored as one,
  // so it is served as bytes from /i/<token>/logo. Omitted entirely when there
  // is no logo — a broken preview image is worse than a text-only card.
  const ogImage = inv.biz_logo
    ? `\n<meta property="og:image" content="${esc(shareUrl(env, token))}/logo">`
    : "";

  // The Pay button is inert markup plus a fetch; Checkout is only loaded when
  // there is something to pay, so a settled invoice pulls no third-party script.
  //
  // The reassurance under it is a plain statement of fact, not a badge: Checkout
  // runs in an iframe served by razorpay.com, so the card number is entered into
  // Razorpay's page and this Worker never sees it. Someone deciding whether to
  // trust an unfamiliar link is asking exactly that question, and until now the
  // page did not answer it.
  const payUi = can.ok ? `
    <div class="paywrap">
      <button id="pay" class="pay">Pay ${esc(amountLabel)}</button>
      <div id="msg" class="msg"></div>
      <div class="secure">
        <img src="/razorpay.svg" alt="Razorpay" class="rzp" width="104" height="22">
        <div class="secure-note">Card and UPI details are entered on Razorpay's
          secure checkout. This page never sees them.</div>
      </div>
    </div>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <script>${payScript(token, bizName, inv)}</script>` :
    (isPaid || !can.why || can.why === "paid" ? "" :
      `<div class="paywrap"><div class="msg">${esc(can.why)}</div></div>`);

  // Somewhere to check before paying. "Let me call them first" is what a careful
  // person does with an unfamiliar link, and a page with no way to do that gives
  // them only two options: pay on faith, or don't pay.
  const contactBits = [
    inv.biz_phone ? `<a href="tel:${esc(String(inv.biz_phone).replace(/[^\d+]/g, ""))}">${esc(inv.biz_phone)}</a>` : "",
    inv.biz_email ? `<a href="mailto:${esc(inv.biz_email)}">${esc(inv.biz_email)}</a>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const contact = contactBits
    ? `<div class="contact">Questions about this invoice? Contact ${esc(bizName)}:<br>${contactBits}</div>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- An invoice carries a client's name and address. It must never be indexed;
     the X-Robots-Tag header below says the same thing to crawlers that do not
     execute or parse the document. -->
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Invoice ${esc(inv.number || "")} — ${esc(bizName)}</title>
<!-- Link preview for WhatsApp / SMS / Slack. A bare URL in a chat is what a scam
     looks like; a card with the business name and logo is the cheapest way to
     look like what it is.

     The AMOUNT and the CLIENT'S NAME are deliberately absent. A preview renders
     for everyone in the chat the link is forwarded to, and unlike the page
     itself it cannot be un-seen by closing the tab. The invoice number is
     included because the recipient needs to recognise which invoice it is. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(bizName)}">
<meta property="og:title" content="Invoice ${esc(inv.number || "")} from ${esc(bizName)}">
<meta property="og:description" content="View this invoice and pay it securely with Razorpay.">
<meta property="og:url" content="${esc(shareUrl(env, token))}">${ogImage}
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#4f46e5">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; background:#f4f4f5; color:#18181b; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
  .sheet { max-width:680px; margin:0 auto; padding:18px 12px 48px; }
  .card { background:#fff; border-radius:14px; box-shadow:0 1px 3px rgba(0,0,0,.09); overflow:hidden; }
  .banner { padding:13px 16px; font-weight:700; font-size:14px; }
  .banner.paid { background:#dcfce7; color:#166534; }
  .paywrap { margin-top:18px; text-align:center; }
  .pay { width:100%; max-width:420px; padding:15px 22px; font-size:16px; font-weight:700;
         color:#fff; background:#4f46e5; border:0; border-radius:11px; cursor:pointer; }
  .pay:hover { background:#4338ca; }
  .pay:disabled { opacity:.6; cursor:default; }
  .msg { margin-top:11px; font-size:13px; color:#52525b; min-height:18px; }
  .msg.err { color:#b91c1c; }
  .msg.ok  { color:#166534; font-weight:600; }
  .secure { margin-top:14px; }
  .rzp { height:22px; width:auto; opacity:.9; }
  .secure-note { margin:7px auto 0; max-width:360px; font-size:11.5px;
                 line-height:1.5; color:#71717a; }
  .contact { margin-top:22px; text-align:center; font-size:12px; color:#71717a;
             line-height:1.7; }
  .contact a { color:#4f46e5; text-decoration:none; font-weight:600; }
  .contact a:hover { text-decoration:underline; }
  @media (prefers-color-scheme: dark) {
    body { background:#18181b; color:#fafafa; }
    .card { background:#fff; }          /* the invoice itself stays a white sheet */
    .msg, .secure-note, .contact { color:#a1a1aa; }
    .contact a { color:#a5b4fc; }
    /* The wordmark is dark navy; lift it off a dark page. */
    .rzp { background:#fff; padding:5px 9px; border-radius:6px; opacity:1; }
  }
</style>
</head><body>
  <div class="sheet">
    <div class="card">${banner}${body}</div>
    ${payUi}
    ${contact}
  </div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow, noarchive",
      // The amount and status can change; never let a shared link be cached as
      // "unpaid" by an intermediary after it has been settled.
      "cache-control": "no-store",
    },
  });
}

/* GET /i/:token/logo — the business logo as image bytes.

   The logo lives on the user row as a data: URI, which is fine for a browser and
   useless to a link-preview crawler: WhatsApp, Slack and iMessage all fetch
   og:image over HTTP and will not decode a data: URI. This turns it back into a
   normal image response.

   Gated by the same token as the page, so it exposes nothing the holder of the
   link cannot already see. */
export async function shareLogo(env, token) {
  const loaded = await loadByToken(env, token);
  if (!loaded) return new Response("not found", { status: 404 });

  const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/i
    .exec(String(loaded.inv.biz_logo || "").trim());
  if (!m) return new Response("no logo", { status: 404 });

  // atob gives a binary string; Uint8Array.from turns it into the bytes a
  // Response body needs. No Buffer without nodejs_compat.
  const bin = atob(m[2]);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));

  return new Response(bytes, {
    headers: {
      "content-type": m[1],
      // The logo rarely changes and a crawler may fetch it repeatedly; the
      // token in the path makes the URL specific enough to cache safely.
      "cache-control": "public, max-age=3600",
      "x-robots-tag": "noindex",
    },
  });
}

function notFoundPage() {
  // Deliberately says nothing about whether the token merely expired, was
  // revoked, or never existed — an enumerable difference would be a way to
  // probe for live links.
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
     <title>Invoice not found</title>
     <div style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#3f3f46">
       <h1 style="font-size:19px">Invoice not found</h1>
       <p style="color:#71717a;font-size:14px">This link is not valid. Please ask the sender for a new one.</p>
     </div>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8",
                              "x-robots-tag": "noindex, nofollow" } });
}

/* JSON safe to embed inside a <script> block.

   JSON.stringify escapes quotes but NOT the two-character sequence `</`, so a
   value containing `</script>` closes the block early and everything after it
   is parsed as HTML — arbitrary script execution on this page.

   That is reachable by someone who is not the invoice owner: client_name on a
   shop-raised invoice is whatever the customer typed at checkout (ingest.js
   maps it straight from `customer.name`). Escaping `<` as < is the fix —
   JSON.parse and the JS parser both read it back as `<`, so the value is
   unchanged, but the HTML tokeniser never sees a tag.

   U+2028/U+2029 are legal in JSON strings and were illegal in JS string
   literals before ES2019; escaped too, since this is pasted into source. */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) =>
      (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

// The page's own script. Kept as a string rather than a static asset because the
// token and invoice details are baked in, and a static file would have to fetch
// them separately anyway.
function payScript(token, bizName, inv) {
  const cfg = jsonForScript({
    token,
    name: bizName,
    description: `Invoice ${inv.number || ""}`.trim(),
    prefill: {
      name: inv.client_name || "",
      email: inv.client_email || "",
    },
  });
  return `
(function(){
  var CFG = ${cfg};
  var btn = document.getElementById('pay'), msg = document.getElementById('msg');
  var was = btn.textContent;
  function say(text, cls){ msg.textContent = text; msg.className = 'msg' + (cls ? ' ' + cls : ''); }
  function reset(){ btn.disabled = false; btn.textContent = was; }

  btn.onclick = async function(){
    btn.disabled = true; btn.textContent = 'Preparing…'; say('');
    var order;
    try {
      var r = await fetch('/api/pay/' + CFG.token + '/order', {method:'POST'});
      order = await r.json();
      if (!r.ok || !order.orderId) throw new Error(order.error || 'Could not start the payment.');
    } catch (e) { say(e.message || String(e), 'err'); reset(); return; }

    var rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: 'INR',
      name: CFG.name,
      description: CFG.description,
      prefill: CFG.prefill,
      // Dismissing the modal is not a failure — put the button back so they can
      // try again, rather than leaving a dead page.
      modal: { ondismiss: function(){ reset(); say(''); } },
      handler: async function(resp){
        btn.textContent = 'Confirming…';
        try {
          await fetch('/api/pay/' + CFG.token + '/verify', {
            method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify(resp),
          });
        } catch (e) { /* the webhook is the record; this call is only for the UI */ }
        // Reload so the page re-renders from the server. If the webhook has
        // landed the banner says Paid; if not, this message is the receipt.
        btn.textContent = 'Paid ✓';
        say('Payment received. Thank you!', 'ok');
        setTimeout(function(){ location.reload(); }, 2500);
      },
    });
    rzp.on('payment.failed', function(e){
      say((e && e.error && e.error.description) || 'Payment failed. Please try again.', 'err');
      reset();
    });
    rzp.open();
    btn.textContent = was;
  };
})();`;
}

// ── POST /api/pay/:token/order ───────────────────────────────────────────────
export async function createPayOrder(env, token) {
  const loaded = await loadByToken(env, token);
  if (!loaded) return bad("invoice not found", 404);

  const { inv, items } = loaded;
  const t = computeTotals(inv, items);
  const can = payability(env, inv, t.total);
  if (!can.ok) {
    // 409, not 400: nothing about the request is malformed — the invoice is
    // simply not in a payable state (already settled, wrong currency, disabled).
    return json({ error: can.why === "paid" ? "This invoice is already paid." : can.why }, 409);
  }

  const amountPaise = paise(t.total);

  // Reuse the order while it is still for the right amount. A client refreshing
  // the page would otherwise leave a trail of orphan Razorpay orders, and an
  // invoice edited after sharing would keep charging the old total.
  if (inv.rzp_order_id && Number(inv.rzp_amount) === amountPaise) {
    return json({
      orderId: inv.rzp_order_id, amount: amountPaise, keyId: publicKeyId(env),
    });
  }

  const rzp = await createOrder(env, {
    amountPaise,
    // Razorpay caps receipt at 40 chars; the invoice number is what makes the
    // payment recognisable in their dashboard.
    receipt: String(inv.number || inv.id).slice(0, 40),
    notes: { invoice_id: inv.id, invoice_number: inv.number || "", source: "invoicer" },
  });

  if (!rzp.ok) {
    if (rzp.status === 401) {
      // A 401 is a configuration problem and retrying cannot fix it. Log the
      // distinction — Razorpay's description separates "wrong keys" from
      // "expired key" — but never log the key itself.
      console.error("razorpay auth rejected (401):", rzp.error || "no description",
        "— key id ends", String(env.RAZORPAY_KEY_ID || "").slice(-4) || "unset");
      return json({ error: "Online payment is unavailable right now." }, 503);
    }
    console.error("razorpay order failed", rzp.status, rzp.error || "");
    return json({ error: "Could not start the payment. Please try again." }, 502);
  }

  await env.DB.prepare(
    "UPDATE invoices SET rzp_order_id=?, rzp_amount=?, updated_at=? WHERE id=?"
  ).bind(rzp.order.id, amountPaise, now(), inv.id).run();

  return json({ orderId: rzp.order.id, amount: amountPaise, keyId: publicKeyId(env) });
}

// ── POST /api/pay/:token/verify ──────────────────────────────────────────────
//
// Signature-verified, and deliberately does NOT set PAID. This is delivered by
// the browser that just paid; the webhook is Razorpay's own word and the only
// thing trusted to change the invoice's status.
export async function verifyPayCallback(env, token, body) {
  const loaded = await loadByToken(env, token);
  if (!loaded) return bad("invoice not found", 404);

  const orderId = String(body?.razorpay_order_id || "").slice(0, 100);
  const paymentId = String(body?.razorpay_payment_id || "").slice(0, 100);
  const signature = String(body?.razorpay_signature || "").slice(0, 200);
  if (!orderId || !paymentId || !signature) return bad("missing payment details", 400);

  // The order must be the one WE created for this invoice, or a valid signature
  // from some other order would attach a stranger's payment id to it.
  if (orderId !== loaded.inv.rzp_order_id) {
    console.error("callback for a different order", { invoice: loaded.inv.id, orderId });
    return bad("payment could not be verified", 400);
  }

  const valid = await verifyCallbackSignature(env, { orderId, paymentId, signature });
  if (!valid) {
    console.error("callback signature mismatch", { orderId, paymentId });
    return bad("payment could not be verified", 400);
  }

  // COALESCE so a second callback cannot overwrite the first payment id.
  await env.DB.prepare(
    "UPDATE invoices SET rzp_payment_id=COALESCE(rzp_payment_id,?), updated_at=? WHERE id=?"
  ).bind(paymentId, now(), loaded.inv.id).run();

  return json({ ok: true, status: loaded.inv.status });
}

// ── POST /api/webhook/razorpay ───────────────────────────────────────────────
//
// Called with the raw Request, before any body parsing: the HMAC covers the exact
// bytes sent, so JSON.stringify(JSON.parse(raw)) would not verify.
export async function razorpayWebhook(request, env, ctx) {
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    console.error("webhook received but RAZORPAY_WEBHOOK_SECRET is unset");
    return bad("not configured", 503);
  }
  if (!await verifyWebhookSignature(env, raw, signature)) {
    console.error("webhook signature mismatch");
    return bad("invalid signature", 400);
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return bad("bad payload", 400); }

  const eventId = request.headers.get("x-razorpay-event-id") || "";
  const eventType = evt?.event || "";

  // Idempotency. Delivery is at-least-once and unordered, so the same event can
  // arrive twice; the PK makes the second insert a no-op and meta.changes tells
  // us whether this delivery was the first. Without it a redelivery would email
  // the client a second receipt.
  if (eventId) {
    const ins = await env.DB.prepare(
      "INSERT OR IGNORE INTO webhook_events (event_id,event_type,received_at) VALUES (?,?,?)"
    ).bind(eventId, eventType, now()).run();
    if (ins.meta?.changes === 0) return json({ ok: true, duplicate: true });
  }

  if (eventType === "order.paid") {
    await handleOrderPaid(env, ctx, evt, eventId);
  } else if (eventType === "payment.failed") {
    const p = evt?.payload?.payment?.entity || {};
    console.warn("payment failed", p.order_id, p.error_description || "");
  }

  // Razorpay times out at ~5s, so return immediately; the emails go out in the
  // background via ctx.waitUntil.
  return json({ ok: true });
}

async function handleOrderPaid(env, ctx, evt, eventId) {
  const rzpOrder = evt?.payload?.order?.entity || {};
  const payment = evt?.payload?.payment?.entity || {};
  const rzpOrderId = rzpOrder.id || payment.order_id;
  if (!rzpOrderId) return;

  const inv = await env.DB.prepare(
    `SELECT i.*, u.email AS owner_email, u.biz_name
       FROM invoices i JOIN users u ON u.id = i.user_id
      WHERE i.rzp_order_id = ?`
  ).bind(rzpOrderId).first();

  if (!inv) {
    // Expected, not an error: this account's webhook also receives order.paid
    // for the SHOP's orders, which are none of Invoicer's business. Logged at
    // info and answered 200 so Razorpay stops retrying an event that is not ours.
    console.log("order.paid for an order Invoicer does not own", rzpOrderId);
    return;
  }

  // Already settled — a second event id for the same order (or a manual status
  // change that beat the webhook) must not re-send the receipt.
  if (String(inv.status || "").toUpperCase() === "PAID") {
    console.log("order.paid for an invoice already marked paid", inv.id);
    return;
  }

  const paidAt = Number(payment.created_at) ? Number(payment.created_at) * 1000 : now();

  await env.DB.prepare(
    `UPDATE invoices SET status='PAID', paid_at=?, rzp_payment_id=COALESCE(rzp_payment_id,?),
            updated_at=? WHERE id=?`
  ).bind(paidAt, payment.id || null, now(), inv.id).run();

  if (eventId) {
    await env.DB.prepare("UPDATE webhook_events SET invoice_id=? WHERE event_id=?")
      .bind(inv.id, eventId).run();
  }

  // Emails are best-effort and must not hold up the response. The invoice is
  // already PAID in the database at this point — that is the record; a bounced
  // email is a nuisance, a webhook timeout is a retry storm.
  const send = notifyPaid(env, inv, payment);
  if (ctx?.waitUntil) ctx.waitUntil(send); else await send;
}

async function notifyPaid(env, inv, payment) {
  const bizName = (inv.biz_name || "Invoicer").trim();
  const cur = inv.currency || PAYABLE_CURRENCY;
  const amount = `${cur} ${(Number(payment.amount || 0) / 100).toFixed(2)}`;
  const num = inv.number || inv.id;
  const ref = payment.id ? ` Payment reference ${payment.id}.` : "";

  const tasks = [];

  if (inv.client_email) {
    tasks.push(sendEmail(env, {
      to: inv.client_email,
      fromName: `${bizName} Billing`,
      subject: `Payment received — invoice ${num}`,
      text: `Thank you. We've received ${amount} for invoice ${num}.${ref}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#166534;margin:0 0 12px">Payment received</h2>
        <p>Thank you — we've received <b>${esc(amount)}</b> for invoice <b>${esc(num)}</b>.</p>
        ${payment.id ? `<p style="color:#6b7280;font-size:12px">Payment reference ${esc(payment.id)}</p>` : ""}
        <p style="color:#6b7280;font-size:12px">${esc(bizName)}</p></div>`,
    }));
  }

  if (inv.owner_email) {
    tasks.push(sendEmail(env, {
      to: inv.owner_email,
      fromName: "Invoicer",
      subject: `Invoice ${num} paid — ${amount}`,
      text: `${inv.client_name || "A client"} paid invoice ${num}. Amount ${amount}.${ref}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#166534;margin:0 0 12px">Invoice ${esc(num)} paid</h2>
        <p><b>${esc(inv.client_name || "A client")}</b> paid <b>${esc(amount)}</b>.</p>
        ${payment.id ? `<p style="color:#6b7280;font-size:12px">Payment reference ${esc(payment.id)}</p>` : ""}
        </div>`,
    }));
  }

  const results = await Promise.allSettled(tasks);
  results.forEach((r) => {
    if (r.status === "rejected" || r.value?.ok === false) {
      console.error("paid notification failed", inv.id, r.reason || r.value?.error);
    }
  });
}

// ── POST /api/invoices/:id/share (session-gated) ─────────────────────────────
//
// Mints the token on first use rather than at save time, so invoices that are
// never shared never get one — a link that does not exist cannot leak.
export async function shareInvoice(env, user, id, url) {
  const inv = await env.DB.prepare(
    "SELECT id, share_token FROM invoices WHERE id=? AND user_id=?"
  ).bind(id, user.id).first();
  if (!inv) return bad("not found", 404);

  let token = inv.share_token;
  if (!token) {
    token = randToken(16);
    await env.DB.prepare("UPDATE invoices SET share_token=?, updated_at=? WHERE id=?")
      .bind(token, now(), inv.id).run();
  }
  return json({ ok: true, token, url: shareUrl(env, token, url) });
}

// APP_BASE_URL wins whenever it is set, which in practice is always: a shared
// link must carry the canonical public origin no matter which hostname the
// request that minted it arrived on. The request origin is only a fallback for
// a deployment that has not configured one.
//
// The practical consequence is that links copied from `wrangler dev` point at
// production — correct for sharing, surprising while testing locally.
export function shareUrl(env, token, url) {
  const base = String(env.APP_BASE_URL || "").replace(/\/+$/, "") ||
    (url ? new URL(url).origin : "");
  return `${base}/i/${token}`;
}
