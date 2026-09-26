/* A public "pay me" page: invoicer.aswincloud.com/pay
 *
 * For the customer who asks on Instagram "how do I pay you?". Until now the
 * answer was "GPay me", which leaves no record. This page takes four fields -
 * name, mobile, what for, how much - and hands off to Razorpay. What lands in
 * Aswin's account is an ordinary PAID invoice, numbered PL-<year>-<n>, with the
 * same receipt email, owner email and WhatsApp confirmation as any other.
 *
 * ── The design rule: nothing is stored until the money has moved ────────────
 *
 * This is the first endpoint where an unauthenticated stranger causes a write.
 * A public form that inserts invoice rows is a spam magnet: a script could
 * fill the database with garbage in seconds, and every row would sit in
 * "My Invoices" as if it were real. So the form does NOT create an invoice. It
 * creates a Razorpay ORDER with the form's fields attached as notes, and the
 * invoice is created from the PAID order, on Razorpay's word, by whichever of
 * three arrives first: confirmPayLink (the browser's signed checkout result,
 * read back from Razorpay's API), the order.paid webhook (handleOrderPaid), or
 * the half-hourly sweep (sweepPayLinks). All three are in pay.js.
 *
 * Consequences, all deliberate:
 *   - an abandoned form leaves nothing behind but an unpaid order on Razorpay's
 *     side, which expires on its own
 *   - the amount stored is the amount Razorpay says was paid, never what the
 *     form said - the form value only sizes the order
 *   - idempotency comes free from the existing webhook_events table plus the
 *     UNIQUE index on source_ref, which is the Razorpay order id here
 *
 * Bounds keep the books sane: PAYLINK_MIN / PAYLINK_MAX rupees, defaults 10 and
 * 50,000. Turnstile, when configured, stops bots reaching Razorpay at all.
 */

import { json, bad, uid, now, randToken } from "./lib.js";
import { createOrder, publicKeyId, paymentsConfigured } from "./razorpay.js";
import { toE164 } from "./wa.js";
import { defaultBusiness } from "./business.js";
import { esc } from "./invoice-html.js";

export const PAYLINK_SOURCE = "paylink";

/* Which of the owner's businesses /pay bills as. PAYLINK_BUSINESS names one by
 * biz_name (case-insensitive); unset, or not found, means the default business.
 * So the generic pay-me page can bill as AswinCloud while the shop's orders bill
 * as Aswin3DPrints, from the same account — the header on the receipt PDF and
 * the {{5}} in the WhatsApp both come from this row. */
export async function paylinkBusiness(env, userId) {
  const want = String(env.PAYLINK_BUSINESS || "").trim();
  if (want) {
    const row = await env.DB.prepare(
      "SELECT * FROM businesses WHERE user_id=? AND lower(biz_name)=lower(?) LIMIT 1"
    ).bind(userId, want).first();
    if (row) return row;
    console.error("paylink: PAYLINK_BUSINESS not found on this account, using the default", want);
  }
  return defaultBusiness(env, userId);
}
const NOTE_KEY = "invoicer_paylink";       // marks an order as ours to turn into an invoice

const minRupees = (env) => Math.max(1, Number(env.PAYLINK_MIN || 10));
const maxRupees = (env) => Math.max(minRupees(env), Number(env.PAYLINK_MAX || 50000));

export const paylinkEnabled = (env) =>
  String(env.PAY_ENABLED ?? "").toLowerCase() === "true" &&
  String(env.PAYLINK_ENABLED ?? "true").toLowerCase() !== "false" &&
  paymentsConfigured(env);

/* Validate the form. Returns { ok:true, ...clean } or { ok:false, error }.
 * Pure, so the tests can throw every shape of garbage at it. */
export function validatePayForm(env, b) {
  const name = String(b?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const what = String(b?.what ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
  // Optional fields fail closed on SHAPE, not presence: a blank phone is fine
  // (they simply get no WhatsApp receipt), a mistyped one is refused rather than
  // stored as something a later send would have to guess at.
  const phoneRaw = String(b?.phone ?? "").trim();
  const phone = phoneRaw ? toE164(phoneRaw) : "";
  const email = String(b?.email ?? "").trim().toLowerCase().slice(0, 120);
  // Where to send it. Line breaks kept - an address is typed on several lines
  // and prints that way on the invoice. Razorpay caps a single note at 256
  // characters, so it is clamped to fit the ride through the order.
  const address = String(b?.address ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n").slice(0, 250);
  const amountNum = Number(String(b?.amount ?? "").replace(/[₹,\s]/g, ""));

  if (name.length < 2) return { ok: false, error: "Please enter your name." };
  if (phoneRaw && !phone) return { ok: false, error: "That mobile number does not look right (e.g. 98765 43210)." };
  if (address && address.length < 8) return { ok: false, error: "That address looks incomplete - please include the PIN code, or leave it blank." };
  if (!Number.isFinite(amountNum) || amountNum <= 0) return { ok: false, error: "Please enter the amount in rupees." };
  if (amountNum < minRupees(env)) return { ok: false, error: `The minimum is ₹${minRupees(env)}.` };
  if (amountNum > maxRupees(env)) return { ok: false, error: `The maximum here is ₹${maxRupees(env).toLocaleString("en-IN")}. For larger amounts please ask for an invoice.` };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email address does not look right." };

  // Whole paise. 350.005 must not become a 35000.5-paise order.
  const amountPaise = Math.round(amountNum * 100);
  return { ok: true, name, phone, what, email, address, amountPaise };
}

/* Cloudflare Turnstile, when a secret is configured. Absent secret = not
 * enforced, so a deploy without it still works; the form simply has no bot
 * check. Never throws - a Turnstile outage must not take payments down. */
async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip || "" }),
    });
    const d = await r.json().catch(() => ({}));
    return d.success === true;
  } catch (e) {
    console.error("turnstile verify failed open?", String(e?.message || e));
    return false;                         // fail CLOSED: no verification, no order
  }
}

/* POST /api/pay/start - the form submits here. Creates the Razorpay order and
 * returns what Checkout needs. Creates NO invoice. */
export async function startPayLink(request, env, body) {
  if (!paylinkEnabled(env)) return json({ error: "Online payment is not available right now." }, 503);

  const v = validatePayForm(env, body);
  if (!v.ok) return bad(v.error);

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!await turnstileOk(env, body?.turnstile, ip)) return bad("Please complete the verification and try again.", 403);

  // Whose books this lands in. From config, never from the request.
  const ownerEmail = String(env.INVOICE_OWNER_EMAIL || "").trim().toLowerCase();
  const user = ownerEmail
    ? await env.DB.prepare("SELECT id FROM users WHERE lower(email)=?").bind(ownerEmail).first() : null;
  const biz = user ? await paylinkBusiness(env, user.id) : null;
  if (!user || !biz) {
    console.error("paylink: owner or default business not configured");
    return json({ error: "Online payment is not available right now." }, 503);
  }

  // A short reference the customer sees on Razorpay's screen and in their bank
  // statement, and that we can find the order by if the webhook is ever missed.
  const ref = "PL-" + randToken(4).toUpperCase();

  const rzp = await createOrder(env, {
    amountPaise: v.amountPaise,
    receipt: ref,
    notes: {
      [NOTE_KEY]: "1",
      source: PAYLINK_SOURCE,
      name: v.name, phone: v.phone, email: v.email, what: v.what, address: v.address,
      ref,
    },
  });
  if (!rzp.ok) {
    if (rzp.status === 401)
      console.error("razorpay auth rejected (401) on paylink — key id ends", String(env.RAZORPAY_KEY_ID || "").slice(-4) || "unset");
    else console.error("paylink order failed", rzp.status, rzp.error || "");
    return json({ error: "Could not start the payment. Please try again." }, 502);
  }

  return json({
    orderId: rzp.order.id, amount: v.amountPaise, keyId: publicKeyId(env), ref,
    prefill: { name: v.name, contact: "+" + v.phone, email: v.email },
    business: biz.biz_name || "",
  });
}

/* Is this Razorpay order one of ours to turn into an invoice? */
export const isPayLinkOrder = (rzpOrder) =>
  !!(rzpOrder && rzpOrder.notes && rzpOrder.notes[NOTE_KEY] === "1");

/* Called from handleOrderPaid when order.paid arrives for a pay-link order.
 * Creates the PAID invoice from the order's notes and Razorpay's own amount.
 * Returns { inv, created } — the joined row notifyPaid wants, and whether THIS
 * call made it. An existing row (a redelivery, or reconcile and the webhook
 * racing) comes back with created:false so the caller sends nothing twice. Null
 * when the owner or business is not configured or the amount is zero.
 *
 * Idempotent two ways: webhook_events has already dropped a redelivered event
 * id, and source_ref = the Razorpay order id is UNIQUE, so two different event
 * ids for one order (order.paid + payment.captured, say) still make one
 * invoice. */
export async function invoiceFromPaidOrder(env, rzpOrder, payment) {
  const notes = rzpOrder.notes || {};
  const ownerEmail = String(env.INVOICE_OWNER_EMAIL || "").trim().toLowerCase();
  const user = ownerEmail
    ? await env.DB.prepare("SELECT * FROM users WHERE lower(email)=?").bind(ownerEmail).first() : null;
  if (!user) { console.error("paylink webhook: owner not configured"); return null; }
  const biz = await paylinkBusiness(env, user.id);
  if (!biz) { console.error("paylink webhook: no default business"); return null; }

  const existing = await env.DB.prepare(
    `SELECT i.*, u.email AS owner_email, b.biz_name FROM invoices i
       JOIN users u ON u.id = i.user_id LEFT JOIN businesses b ON b.id = i.business_id
      WHERE i.source_ref = ?`).bind(rzpOrder.id).first();
  if (existing) return { inv: existing, created: false };

  // Razorpay's word on the amount, in rupees. amount_paid is what was actually
  // captured; the order amount is the fallback for a webhook shape without it.
  const paise = Number(payment?.amount) || Number(rzpOrder.amount_paid) || Number(rzpOrder.amount) || 0;
  const total = Math.round(paise) / 100;
  if (total <= 0) { console.error("paylink webhook: zero amount", rzpOrder.id); return null; }

  const paidAt = Number(payment?.created_at) ? Number(payment.created_at) * 1000 : now();
  const d = new Date(paidAt);
  const year = d.getFullYear();
  // PL-<year>-<serial>: sequential per year, read from the table under the
  // same UNIQUE-index race protection the shop path relies on.
  const last = await env.DB.prepare(
    "SELECT number FROM invoices WHERE user_id=? AND number LIKE ? ORDER BY number DESC LIMIT 1"
  ).bind(user.id, `PL-${year}-%`).first();
  const serial = last ? (parseInt(String(last.number).split("-").pop(), 10) || 0) + 1 : 1;
  const number = `PL-${year}-${String(serial).padStart(4, "0")}`;

  const id = uid(); const t = now();
  const what = String(notes.what || "").trim().slice(0, 160) || "Payment";
  try {
    await env.DB.prepare(
      `INSERT INTO invoices (id,user_id,business_id,number,issue_date,due_date,currency,tax_mode,tax_rate,
         discount_pct,shipping,shipping_mode,round_off,show_pay_qr,status,notes,client_name,client_email,
         client_phone,client_addr,client_gst,total,paid_at,rzp_order_id,rzp_amount,rzp_payment_id,
         share_token,source,source_ref,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, user.id, biz.id, number, d.toISOString().slice(0, 10), "", "₹", "none", 0,
      0, 0, "", 0, 0, "PAID", "Paid online via the pay link.",
      String(notes.name || "").slice(0, 80), String(notes.email || "").slice(0, 120),
      toE164(notes.phone) || "", String(notes.address || "").slice(0, 250), "", total, paidAt, rzpOrder.id, paise, payment?.id || null,
      randToken(16), PAYLINK_SOURCE, rzpOrder.id, t, t,
    ).run();
    await env.DB.prepare(
      "INSERT INTO line_items (id,invoice_id,pos,description,qty,rate) VALUES (?,?,?,?,?,?)"
    ).bind(uid(), id, 0, what, 1, total).run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
      const won = await env.DB.prepare(
        `SELECT i.*, u.email AS owner_email, b.biz_name FROM invoices i
           JOIN users u ON u.id = i.user_id LEFT JOIN businesses b ON b.id = i.business_id
          WHERE i.source_ref = ?`).bind(rzpOrder.id).first();
      return won ? { inv: won, created: false } : null;
    }
    throw e;
  }
  console.log(JSON.stringify({ msg: "paylink invoice created", number, total, order: rzpOrder.id }));
  const inv = await env.DB.prepare(
    `SELECT i.*, u.email AS owner_email, b.biz_name FROM invoices i
       JOIN users u ON u.id = i.user_id LEFT JOIN businesses b ON b.id = i.business_id
      WHERE i.id = ?`).bind(id).first();
  return inv ? { inv, created: true } : null;
}

/* GET /pay - the page. Server-rendered, no framework, same visual language as
 * the invoice pay page so the two read as one product. */
export async function payLinkPage(env) {
  const ownerEmail = String(env.INVOICE_OWNER_EMAIL || "").trim().toLowerCase();
  const user = ownerEmail
    ? await env.DB.prepare("SELECT id FROM users WHERE lower(email)=?").bind(ownerEmail).first() : null;
  const biz = user ? await paylinkBusiness(env, user.id) : null;
  const bizName = (biz && biz.biz_name) || "us";
  const enabled = paylinkEnabled(env) && !!biz;
  const site = env.TURNSTILE_SITE_KEY || "";
  const min = minRupees(env), max = maxRupees(env);
  const udyam = biz && biz.biz_udyam ? `<div class="fine">Udyam Reg. No. (MSME): <b>${esc(biz.biz_udyam)}</b></div>` : "";
  const contact = biz ? [
    biz.biz_phone ? `<a href="tel:${esc(String(biz.biz_phone).replace(/[^\d+]/g, ""))}">${esc(biz.biz_phone)}</a>` : "",
    biz.biz_email ? `<a href="mailto:${esc(biz.biz_email)}">${esc(biz.biz_email)}</a>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ") : "";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Pay ${esc(bizName)}</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#f4f6f3;font:16px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:#1a1f18}
  .wrap{max-width:440px;margin:0 auto;padding:28px 18px 48px}
  .card{background:#fff;border:1px solid #dbe0d8;border-radius:14px;padding:22px 20px;box-shadow:0 6px 24px rgba(0,0,0,.06)}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#5f6b5c;margin:0 0 18px;font-size:14px}
  label{display:block;font-size:13px;font-weight:600;color:#3b463a;margin:12px 0 4px}
  input{width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;border:1px solid #cfd6cc;border-radius:9px;background:#fff}
  input:focus,textarea:focus{outline:2px solid #2f8f5b33;border-color:#2f8f5b}
  textarea{width:100%;box-sizing:border-box;font:inherit;padding:11px 12px;border:1px solid #cfd6cc;border-radius:9px;background:#fff;resize:vertical}
  .amt{position:relative}.amt input{padding-left:30px;font-size:18px;font-weight:600}
  .amt::before{content:"₹";position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#5f6b5c;font-size:18px}
  .hint{font-size:12px;color:#7a857a;margin-top:4px}
  .opt{font-weight:400;color:#7a857a}
  button{width:100%;margin-top:18px;font:inherit;font-weight:700;font-size:16px;padding:14px;border:0;border-radius:11px;background:#2f8f5b;color:#fff;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .msg{min-height:20px;margin-top:10px;font-size:14px;color:#5f6b5c}.msg.err{color:#b42318}.msg.ok{color:#166534}
  .secure{display:flex;gap:10px;align-items:center;margin-top:16px;font-size:12px;color:#7a857a}
  .secure img{height:18px}
  .fine{margin-top:16px;font-size:12px;color:#7a857a;text-align:center}
  .fine a{color:inherit}
  .off{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:12px;border-radius:9px;font-size:14px}
</style></head>
<body><div class="wrap"><div class="card">
  <h1>Pay ${esc(bizName)}</h1>
  <p class="sub">Just your name and the amount are needed. Add a mobile or email if you'd like a receipt.</p>
  ${enabled ? `
  <form id="f" novalidate>
    <label for="name">Your name</label><input id="name" name="name" autocomplete="name" maxlength="80" required>
    <label for="phone">Mobile <span class="opt">(optional - for your WhatsApp receipt)</span></label><input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="98765 43210" maxlength="20">
    <label for="email">Email <span class="opt">(optional - for the receipt)</span></label><input id="email" name="email" type="email" autocomplete="email" maxlength="120">
    <label for="address">Delivery address <span class="opt">(optional - if something is being sent to you)</span></label><textarea id="address" name="address" rows="3" autocomplete="street-address" placeholder="House / street, area, city – PIN code" maxlength="250"></textarea>
    <label for="what">What is this payment for? <span class="opt">(optional)</span></label><input id="what" name="what" placeholder="e.g. Custom keychain, 2 pcs" maxlength="160">
    <label for="amount">Amount</label><div class="amt"><input id="amount" name="amount" type="number" inputmode="decimal" min="${min}" max="${max}" step="1" placeholder="350" required></div>
    <div class="hint">Between ₹${min} and ₹${max.toLocaleString("en-IN")}. For larger amounts, ask ${esc(bizName)} for an invoice.</div>
    ${site ? `<div class="cf-turnstile" data-sitekey="${esc(site)}" data-size="flexible" style="margin-top:14px"></div>` : ""}
    <button id="pay" type="submit">Pay</button>
    <div id="msg" class="msg" role="status" aria-live="polite"></div>
  </form>
  <div class="secure"><img src="/razorpay.svg" alt="Razorpay"><div>Card and UPI details are entered on Razorpay's secure checkout. This page never sees them.</div></div>` :
  `<div class="off">Online payment is not available right now. Please contact ${esc(bizName)} directly.</div>`}
  ${udyam}
  ${contact ? `<div class="fine">Questions? Contact ${esc(bizName)}: ${contact}</div>` : ""}
</div></div>
${enabled ? `<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
${site ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
<script>
(function(){
  var f=document.getElementById('f'),btn=document.getElementById('pay'),msg=document.getElementById('msg'),was=btn.textContent;
  function say(t,c){msg.textContent=t;msg.className='msg'+(c?' '+c:'')}
  function reset(){btn.disabled=false;btn.textContent=was}
  var amt=document.getElementById('amount');
  amt.addEventListener('input',function(){var n=Number(amt.value);btn.textContent=n>0?'Pay ₹'+n.toLocaleString('en-IN'):was});
  f.addEventListener('submit',async function(e){
    e.preventDefault(); btn.disabled=true; btn.textContent='Preparing…'; say('');
    var body={name:f.name.value,phone:f.phone.value,email:f.email.value,address:f.address.value,what:f.what.value,amount:f.amount.value};
    var ts=f.querySelector('[name="cf-turnstile-response"]'); if(ts) body.turnstile=ts.value;
    var o;
    try{ var r=await fetch('/api/pay/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
         o=await r.json(); if(!r.ok||!o.orderId) throw new Error(o.error||'Could not start the payment.'); }
    catch(err){ say(err.message||String(err),'err'); reset(); if(window.turnstile&&ts){try{turnstile.reset()}catch(_){}} return; }
    var rzp=new Razorpay({key:o.keyId,order_id:o.orderId,amount:o.amount,currency:'INR',name:o.business||'${esc(bizName)}',
      description:f.what.value.slice(0,80),prefill:o.prefill,notes:{ref:o.ref},
      modal:{ondismiss:function(){reset();say('')}},
      handler:function(resp){ btn.textContent='Paid ✓'; f.querySelectorAll('input,textarea').forEach(function(i){i.disabled=true});
        var to=[f.phone.value&&'WhatsApp',f.email.value&&'email'].filter(Boolean).join(' and ');
        say('Payment received — thank you!'+(to?' Your receipt is on its way by '+to+'.':''),'ok');
        // Tell the server now, with Razorpay's signed result, so the receipt goes
        // out this second instead of waiting on the webhook or the half-hourly sweep.
        fetch('/api/pay/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({razorpay_order_id:resp.razorpay_order_id,razorpay_payment_id:resp.razorpay_payment_id,razorpay_signature:resp.razorpay_signature})})
          .then(function(r){return r.json()}).then(function(c){ if(!c||!c.ok||!c.number) return;
            say('Payment received — thank you! Receipt '+c.number+(to?' has been sent by '+to+'.':'.'),'ok');
            if(c.link){ var a=document.createElement('a'); a.href=c.link; a.textContent='Open your receipt'; a.style.marginLeft='6px'; msg.appendChild(a); } })
          .catch(function(){}); }});
    rzp.on('payment.failed',function(e){ say((e&&e.error&&e.error.description)||'Payment failed. Please try again.','err'); reset(); });
    rzp.open(); btn.textContent=was;
  });
})();
</script>` : ""}
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
