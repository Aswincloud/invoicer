// Invoicer Worker — static assets (via ASSETS binding) + /api/* backend.
import {
  json, bad, uid, randToken, now, sign, unsign, parseCookies, cookie,
  sendEmail, isEmail,
} from "./lib.js";
import { renderInvoiceEmail, computeTotals, logoAttachment, qrAttachment,
         signAttachment } from "./invoice-html.js";
import { providersResponse, oauthStart, oauthCallback } from "./oauth-routes.js";
import { ingestOrder } from "./ingest.js";
import { printReceipt } from "./print.js";
import { renderInvoicePdf, toBase64 } from "./invoice-pdf.js";
import {
  attachBusiness, businessById, defaultBusiness, publicBusiness,
  businessValues, businessPatch, BIZ_WRITE_COLUMNS,
} from "./business.js";
import {
  sharePage, shareLogo, createPayOrder, verifyPayCallback, razorpayWebhook,
  shareInvoice, shareUrl,
} from "./pay.js";

const SESSION_COOKIE = "inv_session";
const TOKEN_TTL = 15 * 60 * 1000;          // magic link valid 15 min
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

export default {
  // `ctx` is threaded through for the Razorpay webhook: Razorpay times out at
  // ~5s, so the "payment received" emails go out via ctx.waitUntil after the
  // response rather than inside it.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url, ctx); }
      catch (e) { return bad("server error: " + (e?.message || e), 500); }
    }

    // Public invoice link. Above the assets fallback, which would 404 it — there
    // is no /i/<token> file, the page is rendered from the database.
    const share = url.pathname.match(/^\/i\/([^/]+?)(\/logo)?\/?$/);
    if (share && request.method === "GET") {
      try {
        return share[2] ? await shareLogo(env, share[1])
                        : await sharePage(env, share[1]);
      } catch (e) { return bad("server error: " + (e?.message || e), 500); }
    }

    // everything else → static assets
    return env.ASSETS.fetch(request);
  },
};

// ── auth helpers ─────────────────────────────────────────────────
// One session-signing key for BOTH magic-link and broker OAuth, so a session
// validates no matter how it was created. Prefer the broker-provisioned
// SESSION_SECRET; fall back to AUTH_SIGNING_KEY where the broker isn't wired.
const sessionKey = (env) => env.SESSION_SECRET || env.AUTH_SIGNING_KEY;

async function currentUser(request, env) {
  const secret = sessionKey(env);
  if (!secret) return null;
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const sid = await unsign(raw, secret);
  if (!sid) return null;
  const s = await env.DB.prepare(
    "SELECT s.user_id, s.expires_at FROM sessions s WHERE s.id=?"
  ).bind(sid).first();
  if (!s || s.expires_at < now()) return null;
  return env.DB.prepare("SELECT * FROM users WHERE id=?").bind(s.user_id).first();
}

// ── router ───────────────────────────────────────────────────────
async function api(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  // Dispatched BEFORE the body is parsed: these routes verify an HMAC over the
  // exact bytes sent, and re-serialising a parsed object produces different ones,
  // so the signature would never match.
  //
  // Both are service-to-service and carry their own auth, so they sit above the
  // session gate below — there is no cookie on a Worker-to-Worker call, and none
  // on a webhook from Razorpay either.
  if (p === "/api/ingest/order" && m === "POST") return ingestOrder(request, env);
  if (p === "/api/webhook/razorpay" && m === "POST") return razorpayWebhook(request, env, ctx);

  const body = (m === "POST" || m === "PUT" || m === "PATCH")
    ? await request.json().catch(() => ({})) : {};

  // --- public pay endpoints ---
  //
  // Above the session gate: the person paying an invoice is the client, who has
  // no account here. The share token in the path is what authorises them, and
  // the amount is recomputed server-side regardless of what they send.
  let pm;
  if ((pm = p.match(/^\/api\/pay\/([^/]+)\/order$/)) && m === "POST")
    return createPayOrder(env, pm[1]);
  if ((pm = p.match(/^\/api\/pay\/([^/]+)\/verify$/)) && m === "POST")
    return verifyPayCallback(env, pm[1], body);

  // --- public auth endpoints ---
  if (p === "/api/auth/request" && m === "POST") return authRequest(env, body);
  if (p === "/api/auth/verify"  && m === "GET")  return authVerify(env, url);
  if (p === "/api/auth/logout"  && m === "POST") return authLogout(request, env);
  if (p === "/api/auth/providers" && m === "GET") return providersResponse(env);

  // OAuth SSO (Google / GitHub / Microsoft) via @aswincloud/auth
  let om;
  if ((om = p.match(/^\/api\/auth\/oauth\/(google|github|microsoft)$/)) && m === "GET")
    return oauthStart(env, om[1]);
  if ((om = p.match(/^\/api\/auth\/oauth\/(google|github|microsoft)\/callback$/)) && m === "GET")
    return oauthCallback(env, om[1], request);

  // --- everything below requires a session ---
  const user = await currentUser(request, env);
  if (p === "/api/me" && m === "GET")
    return json({ user: user ? await publicUser(env, user) : null });
  if (!user) return bad("unauthorized", 401);

  let match;
  if (p === "/api/profile" && m === "PUT")   return saveProfile(env, user, body);
  if (p === "/api/businesses" && m === "GET")  return listBusinesses(env, user);
  if (p === "/api/businesses" && m === "POST") return createBusiness(env, user, body);
  if ((match = p.match(/^\/api\/businesses\/([^/]+)$/))) {
    if (m === "PUT")    return updateBusiness(env, user, match[1], body);
    if (m === "DELETE") return deleteBusiness(env, user, match[1]);
  }
  if (p === "/api/invoices" && m === "GET")  return listInvoices(env, user);
  if (p === "/api/invoices" && m === "POST") return createInvoice(env, user, body);
  if (p === "/api/print"    && m === "POST") return printReceipt(env, user, body);

  // Above the /:id route below, or "next-number" is parsed as an invoice id.
  if (p === "/api/invoices/next-number" && m === "GET")
    return nextInvoiceNumber(env, user, url);

  if ((match = p.match(/^\/api\/invoices\/([^/]+)$/))) {
    if (m === "GET")    return getInvoice(env, user, match[1]);
    if (m === "PUT")    return updateInvoice(env, user, match[1], body);
    if (m === "DELETE") return deleteInvoice(env, user, match[1]);
  }
  if ((match = p.match(/^\/api\/invoices\/([^/]+)\/email$/)) && m === "POST")
    return emailInvoice(env, user, match[1], body);
  if ((match = p.match(/^\/api\/invoices\/([^/]+)\/share$/)) && m === "POST")
    return shareInvoice(env, user, match[1], request.url);

  return bad("not found", 404);
}

/* What the browser gets about the signed-in account.

   `businesses` is the real answer now. `biz` and `defaults` are kept beside it,
   mirroring whichever business is default, because they are what an older cached
   copy of app.js reads — a deploy where the Worker updates before a browser
   picks up the new script must not blank somebody's letterhead mid-invoice. */
async function publicUser(env, u) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM businesses WHERE user_id=? ORDER BY is_default DESC, created_at ASC"
  ).bind(u.id).all();

  const list = (results || []).map(publicBusiness);
  const active = list.find((x) => x.isDefault) || list[0] || null;

  return {
    id: u.id, email: u.email,
    businesses: list,
    defaultBusinessId: active ? active.id : null,
    biz: active ? active.biz : {},
    defaults: active ? active.defaults : {},
  };
}

// ── magic-link auth ──────────────────────────────────────────────
async function authRequest(env, body) {
  const email = (body.email || "").trim().toLowerCase();
  if (!isEmail(email)) return bad("valid email required");

  const token = randToken(32);
  const t = now();
  await env.DB.prepare(
    "INSERT INTO login_tokens (token,email,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(token, email, t, t + TOKEN_TTL).run();

  const link = `${env.APP_BASE_URL}/api/auth/verify?token=${token}`;
  const res = await sendEmail(env, {
    to: email,
    fromName: "Invoicer",
    subject: "Your Invoicer sign-in link",
    text: `Sign in to Invoicer:\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#4f46e5">Sign in to Invoicer</h2>
      <p>Click the button below to sign in. This link expires in 15 minutes.</p>
      <p style="margin:24px 0"><a href="${link}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Sign in</a></p>
      <p style="color:#6b7280;font-size:12px">If the button doesn't work, paste this URL:<br>${link}</p>
      <p style="color:#9ca3af;font-size:11px">Didn't request this? You can safely ignore it.</p></div>`,
  });
  if (!res.ok) return bad("could not send email: " + (res.error || res.status), 502);
  return json({ ok: true, message: "Check your email for the sign-in link." });
}

async function authVerify(env, url) {
  const token = url.searchParams.get("token") || "";
  const row = await env.DB.prepare("SELECT * FROM login_tokens WHERE token=?")
    .bind(token).first();
  const redirect = (to) => new Response(null, { status: 302, headers: { Location: to } });

  if (!row || row.used_at || row.expires_at < now())
    return redirect("/?auth=invalid");

  await env.DB.prepare("UPDATE login_tokens SET used_at=? WHERE token=?")
    .bind(now(), token).run();

  // find or create user (case-insensitive match; row.email is already lowercased
  // at request time, and OAuth lowercases too — so both methods share one row).
  const email = (row.email || "").trim().toLowerCase();
  let user = await env.DB.prepare("SELECT * FROM users WHERE lower(email)=?")
    .bind(email).first();
  if (!user) {
    const id = uid();
    await env.DB.prepare("INSERT INTO users (id,email,created_at) VALUES (?,?,?)")
      .bind(id, email, now()).run();
    user = { id };
  }

  // create session
  const sid = randToken(32);
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(sid, user.id, now(), now() + SESSION_TTL).run();
  const signed = await sign(sid, sessionKey(env));

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/?auth=ok",
      "Set-Cookie": cookie(SESSION_COOKIE, signed, { maxAge: SESSION_TTL / 1000 }),
    },
  });
}

async function authLogout(request, env) {
  const secret = sessionKey(env);
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (raw && secret) {
    const sid = await unsign(raw, secret);
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(sid).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", { del: true }) });
}

// ── businesses ───────────────────────────────────────────────────
//
// One account, several trading names. Each carries its own identity, its own
// invoice-number prefix and its own tax defaults, and each may carry a shop link
// that gets printed as a QR. See src/business.js.

const WRITE_PLACEHOLDERS = BIZ_WRITE_COLUMNS.split(",").map(() => "?").join(",");

/* PUT /api/profile — edit a business in place.

   Still called "profile" because that is what the form is, but it now writes to
   a row in `businesses` rather than to the user. Without an explicit id it edits
   the default, which is exactly what the single-business case wants and keeps
   an older cached app.js working. */
async function saveProfile(env, user, b) {
  const target = b.businessId
    ? await businessById(env, user.id, b.businessId)
    : await defaultBusiness(env, user.id);
  if (!target) return bad("no such business", 404);

  // Only what the payload carries. The Settings modal sends a subset, and
  // blanking the rest is how the signature and the shop link used to vanish.
  const { cols, vals } = businessPatch(b);
  if (cols.length) {
    await env.DB.prepare(
      `UPDATE businesses SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=? AND user_id=?`
    ).bind(...vals, target.id, user.id).run();
  }

  return json({ ok: true, id: target.id });
}

async function listBusinesses(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM businesses WHERE user_id=? ORDER BY is_default DESC, created_at ASC"
  ).bind(user.id).all();
  return json({ businesses: (results || []).map(publicBusiness) });
}

async function createBusiness(env, user, b) {
  const name = String(b.bizName || "").trim();
  if (!name) return bad("a business needs a name");

  const id = uid();
  const first = !(await defaultBusiness(env, user.id));
  await env.DB.prepare(
    `INSERT INTO businesses (id,user_id,${BIZ_WRITE_COLUMNS},is_default,created_at)
     VALUES (?,?,${WRITE_PLACEHOLDERS},?,?)`
  ).bind(id, user.id, ...businessValues(b), first ? 1 : 0, now()).run();

  return json({ ok: true, id });
}

/* PUT /api/businesses/:id — edit, and optionally make it the default. */
async function updateBusiness(env, user, id, b) {
  const target = await businessById(env, user.id, id);
  if (!target) return bad("no such business", 404);

  const { cols, vals } = businessPatch(b);
  const batch = cols.length ? [
    env.DB.prepare(
      `UPDATE businesses SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=? AND user_id=?`
    ).bind(...vals, id, user.id),
  ] : [];
  if (b.makeDefault) {
    batch.unshift(env.DB.prepare("UPDATE businesses SET is_default=0 WHERE user_id=?").bind(user.id));
    batch.push(env.DB.prepare("UPDATE businesses SET is_default=1 WHERE id=? AND user_id=?")
      .bind(id, user.id));
  }
  await env.DB.batch(batch);
  return json({ ok: true, id });
}

/* DELETE /api/businesses/:id

   Refused while any invoice was issued under it. Deleting would either orphan
   those invoices or, worse, silently re-point them at another business — which
   would rewrite the trading name and GSTIN on documents already sent to
   customers and to the tax authority. Archiving is a feature for another day;
   refusing is the honest answer today. */
async function deleteBusiness(env, user, id) {
  const target = await businessById(env, user.id, id);
  if (!target) return bad("no such business", 404);

  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invoices WHERE business_id=? AND user_id=?"
  ).bind(id, user.id).first();
  if (used && used.n > 0) {
    return bad(`This business has ${used.n} invoice${used.n === 1 ? "" : "s"} issued under it `
             + `and cannot be deleted — their name, GSTIN and payment details come from it.`, 409);
  }

  const { results } = await env.DB.prepare(
    "SELECT id FROM businesses WHERE user_id=? AND id<>? ORDER BY created_at ASC"
  ).bind(user.id, id).all();
  if (!results || !results.length) return bad("an account needs at least one business", 409);

  const batch = [env.DB.prepare("DELETE FROM businesses WHERE id=? AND user_id=?").bind(id, user.id)];
  // Never leave the account without a default.
  if (target.is_default) {
    batch.push(env.DB.prepare("UPDATE businesses SET is_default=1 WHERE id=?").bind(results[0].id));
  }
  await env.DB.batch(batch);
  return json({ ok: true });
}

// ── invoices ─────────────────────────────────────────────────────
async function listInvoices(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT id,number,client_name,issue_date,due_date,status,currency,total,created_at FROM invoices WHERE user_id=? ORDER BY created_at DESC LIMIT 200"
  ).bind(user.id).all();
  return json({ invoices: results || [] });
}

/* The editable half of an invoice, read off a request body.

   Shared by create and update so the two cannot drift on what a field is called
   or how it is clamped. Everything NOT in here — share_token, the rzp_* columns,
   paid_at, source, source_ref, created_at — is owned by the server and survives
   an edit untouched. */
function invoiceFields(b) {
  return {
    number: b.number || "", issue_date: b.issueDate || "", due_date: b.dueDate || "",
    currency: b.currency || "₹", tax_mode: b.taxMode || "gst",
    tax_rate: +b.taxRate || 0, discount_pct: +b.discount || 0,
    shipping: +b.shipping || 0, shipping_mode: (b.shippingMode || "").slice(0, 60),
    // Stored as 0/1 so SQLite keeps it an INTEGER, and snapshot per invoice: the
    // total column is computed with it, so a later toggle must not change what
    // an already-sent invoice re-renders as.
    round_off: b.roundOff ? 1 : 0,
    status: b.status || "UNPAID", notes: b.notes || "",
    client_name: b.clName || "", client_email: b.clEmail || "",
    client_addr: b.clAddr || "", client_gst: b.clGst || "",
  };
}

// Line items are replaced wholesale rather than diffed: they have no stable
// identity in the form (a row is a position, not a thing), so "which row is
// this?" has no answer to diff against.
async function writeLineItems(env, invoiceId, items) {
  await env.DB.prepare("DELETE FROM line_items WHERE invoice_id=?").bind(invoiceId).run();
  const stmt = env.DB.prepare(
    "INSERT INTO line_items (id,invoice_id,pos,description,qty,rate) VALUES (?,?,?,?,?,?)"
  );
  const batch = items.map((it, i) =>
    stmt.bind(uid(), invoiceId, i, it.description || it.desc || "", +it.qty || 0, +it.rate || 0));
  if (batch.length) await env.DB.batch(batch);
}

/* Is this number already spoken for by another of this user's invoices?

   The number field is typed by a human, so a clash is refused rather than
   silently rewritten — quietly renumbering someone's invoice is how you end up
   with a document whose number nobody can find again.

   VOID rows are ignored, matching the partial unique index in migration 0009:
   a cancelled invoice keeps its number for the record, and reusing that number
   for its replacement is normal practice. */
async function numberTaken(env, user, number, exceptId = null) {
  if (!number) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM invoices
      WHERE user_id=? AND number=? AND status <> 'VOID' AND id <> ?`
  ).bind(user.id, number, exceptId || "").first();
  return Boolean(row);
}

async function createInvoice(env, user, b) {
  const id = uid(); const t = now();
  const items = Array.isArray(b.items) ? b.items : [];
  const inv = invoiceFields(b);

  if (await numberTaken(env, user, inv.number))
    return bad(`Invoice number ${inv.number} is already in use.`, 409);

  const { total } = computeTotals(inv, items);

  // Which business is issuing this. Validated against the account rather than
  // trusted, and pinned now rather than looked up at render time — this is the
  // column that stops a reprint two months from now carrying whichever trading
  // name happens to be selected then.
  const biz = (b.businessId && await businessById(env, user.id, b.businessId))
           || await defaultBusiness(env, user.id);

  await env.DB.prepare(
    `INSERT INTO invoices (id,user_id,business_id,number,issue_date,due_date,currency,tax_mode,tax_rate,
       discount_pct,shipping,shipping_mode,round_off,status,notes,client_name,client_email,client_addr,client_gst,total,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, user.id, biz ? biz.id : null,
         inv.number, inv.issue_date, inv.due_date, inv.currency, inv.tax_mode,
         inv.tax_rate, inv.discount_pct, inv.shipping, inv.shipping_mode, inv.round_off,
         inv.status, inv.notes,
         inv.client_name, inv.client_email, inv.client_addr, inv.client_gst, total, t, t).run();

  await writeLineItems(env, id, items);

  return json({ ok: true, id, total });
}

/* Edit an invoice in place.

   Until this existed, Save and Email both created a NEW invoice every press —
   which is how production ended up with 25 invoices under 14 numbers, including
   five copies of one and three copies of another marked PAID at three different
   amounts.

   A PAID invoice is refused. It is a record of money that has moved: an invoice
   paid through the share link carries rzp_payment_id and the exact rzp_amount
   that was charged, and letting a later edit move the total away from that
   produces a document contradicting the customer's bank statement — the failure
   ingest.js exists to prevent on the shop path.

   The lock is decided from the STORED row, never from the submitted body. A
   check against `b.status` would be no lock at all: posting status:"UNPAID"
   would unlock any paid invoice. */
async function updateInvoice(env, user, id, b) {
  const existing = await env.DB.prepare(
    "SELECT id, status, rzp_payment_id FROM invoices WHERE id=? AND user_id=?"
  ).bind(id, user.id).first();
  if (!existing) return bad("not found", 404);

  const paid = String(existing.status || "").toUpperCase() === "PAID" || existing.rzp_payment_id;
  if (paid) {
    // 409, not 403: the request is well-formed and the caller is entitled to
    // this invoice — it is the invoice's state that refuses.
    return bad("This invoice is paid and can no longer be edited. " +
               "Issue a credit note or a new invoice instead.", 409);
  }

  const items = Array.isArray(b.items) ? b.items : [];
  const inv = invoiceFields(b);

  if (await numberTaken(env, user, inv.number, id))
    return bad(`Invoice number ${inv.number} is already in use.`, 409);

  const { total } = computeTotals(inv, items);

  // Named columns only. `created_at`, `share_token`, `rzp_order_id`,
  // `rzp_amount`, `rzp_payment_id`, `paid_at`, `source`, `source_ref` and
  // `business_id` are deliberately absent — a shared pay link must keep working
  // across an edit, the payment trail is not the form's to rewrite, and the
  // business that issued an invoice is not an editable property of it. Moving an
  // invoice between trading names would change the GSTIN on a document already
  // sent; that is a credit note, not an edit.
  await env.DB.prepare(
    `UPDATE invoices SET number=?, issue_date=?, due_date=?, currency=?, tax_mode=?,
       tax_rate=?, discount_pct=?, shipping=?, shipping_mode=?, round_off=?,
       status=?, notes=?, client_name=?, client_email=?, client_addr=?, client_gst=?,
       total=?, updated_at=?
     WHERE id=? AND user_id=?`
  ).bind(inv.number, inv.issue_date, inv.due_date, inv.currency, inv.tax_mode,
         inv.tax_rate, inv.discount_pct, inv.shipping, inv.shipping_mode, inv.round_off,
         inv.status, inv.notes, inv.client_name, inv.client_email, inv.client_addr,
         inv.client_gst, total, now(), id, user.id).run();

  await writeLineItems(env, id, items);

  return json({ ok: true, id, total, updated: true });
}

/* A random invoice number this user is not already using.

   The format stays PREFIX-YEAR-<4 digits> — the alternative, sequential
   numbering, tells a customer how many invoices you have issued. But 4 digits is
   9000 slots, and picking blind gave a 43% chance of a collision within 100
   invoices: production already has two entirely unrelated invoices sharing
   INV-AC-2026-2257 (Rs 350 paid, and Rs 25,000 unpaid).

   Checking here makes a collision unlikely; the unique index in migration 0009
   makes it impossible. */
async function nextInvoiceNumber(env, user, url) {
  // The prefix is a property of the business now. An explicit ?prefix= wins —
  // that is the client telling us which business is filling the form — and the
  // account's default business is the fallback for a caller that sends none.
  let asked = url.searchParams.get("prefix");
  if (!asked) {
    const biz = await defaultBusiness(env, user.id);
    asked = biz ? biz.def_prefix : "";
  }
  const prefix = String(asked || "INV").replace(/[^\w-]/g, "").slice(0, 20) || "INV";
  const year = new Date(now()).getUTCFullYear();

  const { results } = await env.DB.prepare(
    "SELECT number FROM invoices WHERE user_id=? AND status <> 'VOID'"
  ).bind(user.id).all();
  const used = new Set((results || []).map((r) => r.number));

  for (let i = 0; i < 40; i++) {
    const n = `${prefix}-${year}-${Math.floor(Math.random() * 9000) + 1000}`;
    if (!used.has(n)) return json({ number: n });
  }
  // 40 blind misses means the 9000-number space is genuinely crowded for this
  // year. Say so rather than returning a number that will be rejected on save.
  return bad("Could not find a free invoice number — too many used this year.", 409);
}

async function loadInvoice(env, user, id) {
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?")
    .bind(id, user.id).first();
  if (!inv) return null;
  const { results } = await env.DB.prepare(
    "SELECT description,qty,rate,pos FROM line_items WHERE invoice_id=? ORDER BY pos"
  ).bind(id).all();
  // Attach the business that ISSUED this invoice, not whichever one the account
  // happens to have selected now. See src/business.js.
  await attachBusiness(env, inv);
  return { inv, items: results || [] };
}

async function getInvoice(env, user, id) {
  const r = await loadInvoice(env, user, id);
  if (!r) return bad("not found", 404);
  return json(r);
}

async function deleteInvoice(env, user, id) {
  const res = await env.DB.prepare("DELETE FROM invoices WHERE id=? AND user_id=?")
    .bind(id, user.id).run();
  return json({ ok: true, deleted: res.meta?.changes || 0 });
}

async function emailInvoice(env, user, id, b) {
  const r = await loadInvoice(env, user, id);
  if (!r) return bad("not found", 404);
  const to = (b.to || r.inv.client_email || "").trim();
  if (!isEmail(to)) return bad("valid recipient email required");

  // Same CID treatment as the auto-raised invoice: the stored logo is a data:
  // URI, and every mail client strips those, so it has to travel as an
  // attachment. This path had the bug too — the dashboard's "email invoice"
  // button has been sending a broken image for as long as logos have existed.
  //
  // Read off the invoice, not the user: loadInvoice has already attached the
  // business that issued it, so emailing an old AswinCloud invoice sends the
  // AswinCloud logo even while 3DPrints is the account's current default.
  const logo = logoAttachment(r.inv.biz_logo);

  // Mint the share token here too, so an emailed invoice always carries a link
  // the client can pay from — without the owner having to remember to press
  // "Copy link" first. Reuses the existing token when there is one, so the URL
  // in an old email keeps working.
  let payUrl = null;
  if (String(r.inv.status || "").toUpperCase() !== "PAID") {
    let token = r.inv.share_token;
    if (!token) {
      token = randToken(16);
      await env.DB.prepare("UPDATE invoices SET share_token=?, updated_at=? WHERE id=?")
        .bind(token, now(), id).run();
    }
    payUrl = shareUrl(env, token);
  }

  // The order QR travels the same way the logo does, and for the same reason.
  const qr = qrAttachment(r.inv);
  const sign = signAttachment(r.inv);
  const html = renderInvoiceEmail(r.inv, r.items, logo ? logo.src : "", payUrl,
                                  qr ? qr.src : "", sign ? sign.src : "");

  const attachments = [];
  if (logo) attachments.push(logo.attachment);
  if (qr) attachments.push(qr.attachment);
  if (sign) attachments.push(sign.attachment);

  // The PDF. The browser sends one when it has the invoice rendered (a bitmap of
  // the on-screen sheet, which matches what the user is looking at). Accept it
  // only if it looks like a real base64 PDF within a sane size.
  const safeNum = String(r.inv.number || "invoice").replace(/[^A-Za-z0-9._-]/g, "-");
  const pdf = typeof b.pdfBase64 === "string" ? b.pdfBase64.trim() : "";
  if (pdf && pdf.length < 8_000_000 && /^[A-Za-z0-9+/=]+$/.test(pdf)) {
    attachments.push({ filename: `${safeNum}.pdf`, content: pdf, content_type: "application/pdf" });
  } else {
    // No browser PDF — generate one here. Previously this path simply sent no
    // attachment, so an invoice emailed from anywhere the client-side renderer
    // had not run arrived without one.
    try {
      const bytes = renderInvoicePdf(r.inv, r.items, computeTotals(r.inv, r.items));
      attachments.push({ filename: `${safeNum}.pdf`, content: toBase64(bytes), content_type: "application/pdf" });
    } catch (e) {
      console.error("invoice pdf failed", r.inv.number, e?.message || e);
    }
  }

  const bizName = String(r.inv.biz_name || "").trim();
  const res = await sendEmail(env, {
    to,
    fromName: `${bizName || "Invoicer"} Billing`,
    subject: b.subject || `Invoice ${r.inv.number} from ${bizName || "us"}`,
    html,
    text: `Invoice ${r.inv.number}. Total ${r.inv.currency} ${r.inv.total}. View the HTML version in an email client.`,
    attachments: attachments.length ? attachments : undefined,
  });
  if (!res.ok) return bad("email failed: " + (res.error || res.status), 502);
  return json({ ok: true, id: res.id });
}
