// Invoicer Worker — static assets (via ASSETS binding) + /api/* backend.
import {
  json, bad, uid, randToken, now, sign, unsign, parseCookies, cookie,
  sendEmail, isEmail,
} from "./lib.js";
import { renderInvoiceEmail, computeTotals } from "./invoice-html.js";
import { providersResponse, oauthStart, oauthCallback } from "./oauth-routes.js";

const SESSION_COOKIE = "inv_session";
const TOKEN_TTL = 15 * 60 * 1000;          // magic link valid 15 min
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) { return bad("server error: " + (e?.message || e), 500); }
    }
    // everything else → static assets
    return env.ASSETS.fetch(request);
  },
};

// ── auth helpers ─────────────────────────────────────────────────
async function currentUser(request, env) {
  const secret = env.AUTH_SIGNING_KEY;
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
async function api(request, env, url) {
  const p = url.pathname;
  const m = request.method;
  const body = (m === "POST" || m === "PUT" || m === "PATCH")
    ? await request.json().catch(() => ({})) : {};

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
    return json({ user: user ? publicUser(user) : null });
  if (!user) return bad("unauthorized", 401);

  if (p === "/api/profile" && m === "PUT")   return saveProfile(env, user, body);
  if (p === "/api/invoices" && m === "GET")  return listInvoices(env, user);
  if (p === "/api/invoices" && m === "POST") return createInvoice(env, user, body);

  let match;
  if ((match = p.match(/^\/api\/invoices\/([^/]+)$/))) {
    if (m === "GET")    return getInvoice(env, user, match[1]);
    if (m === "DELETE") return deleteInvoice(env, user, match[1]);
  }
  if ((match = p.match(/^\/api\/invoices\/([^/]+)\/email$/)) && m === "POST")
    return emailInvoice(env, user, match[1], body);

  return bad("not found", 404);
}

const publicUser = (u) => ({
  id: u.id, email: u.email,
  biz: { bizName: u.biz_name, bizEmail: u.biz_email, bizAddr: u.biz_addr,
         bizPhone: u.biz_phone, bizGst: u.biz_gst, bizPay: u.biz_pay },
  defaults: {
    currency: u.def_currency || "", taxMode: u.def_tax_mode || "",
    taxRate: u.def_tax_rate || "", discount: u.def_discount || "",
    notes: u.def_notes || "", dueDays: u.def_due_days || "",
    prefix: u.def_prefix || "",
  },
});

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

  // find or create user
  let user = await env.DB.prepare("SELECT * FROM users WHERE email=?")
    .bind(row.email).first();
  if (!user) {
    const id = uid();
    await env.DB.prepare("INSERT INTO users (id,email,created_at) VALUES (?,?,?)")
      .bind(id, row.email, now()).run();
    user = { id };
  }

  // create session
  const sid = randToken(32);
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(sid, user.id, now(), now() + SESSION_TTL).run();
  const signed = await sign(sid, env.AUTH_SIGNING_KEY);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/?auth=ok",
      "Set-Cookie": cookie(SESSION_COOKIE, signed, { maxAge: SESSION_TTL / 1000 }),
    },
  });
}

async function authLogout(request, env) {
  const secret = env.AUTH_SIGNING_KEY;
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (raw && secret) {
    const sid = await unsign(raw, secret);
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(sid).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION_COOKIE, "", { del: true }) });
}

// ── profile ──────────────────────────────────────────────────────
async function saveProfile(env, user, b) {
  const d = b.defaults || {};
  await env.DB.prepare(
    `UPDATE users SET biz_name=?,biz_email=?,biz_addr=?,biz_phone=?,biz_gst=?,biz_pay=?,
       def_currency=?,def_tax_mode=?,def_tax_rate=?,def_discount=?,def_notes=?,def_due_days=?,def_prefix=?
     WHERE id=?`
  ).bind(b.bizName||"", b.bizEmail||"", b.bizAddr||"", b.bizPhone||"", b.bizGst||"", b.bizPay||"",
         d.currency||"", d.taxMode||"", d.taxRate||"", d.discount||"", d.notes||"",
         String(d.dueDays||""), d.prefix||"", user.id).run();
  return json({ ok: true });
}

// ── invoices ─────────────────────────────────────────────────────
async function listInvoices(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT id,number,client_name,issue_date,due_date,status,currency,total,created_at FROM invoices WHERE user_id=? ORDER BY created_at DESC LIMIT 200"
  ).bind(user.id).all();
  return json({ invoices: results || [] });
}

async function createInvoice(env, user, b) {
  const id = uid(); const t = now();
  const items = Array.isArray(b.items) ? b.items : [];
  const inv = {
    number: b.number || "", issue_date: b.issueDate || "", due_date: b.dueDate || "",
    currency: b.currency || "₹", tax_mode: b.taxMode || "gst",
    tax_rate: +b.taxRate || 0, discount_pct: +b.discount || 0,
    status: b.status || "UNPAID", notes: b.notes || "",
    client_name: b.clName || "", client_email: b.clEmail || "",
    client_addr: b.clAddr || "", client_gst: b.clGst || "",
  };
  const { total } = computeTotals(inv, items);

  await env.DB.prepare(
    `INSERT INTO invoices (id,user_id,number,issue_date,due_date,currency,tax_mode,tax_rate,
       discount_pct,status,notes,client_name,client_email,client_addr,client_gst,total,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, user.id, inv.number, inv.issue_date, inv.due_date, inv.currency, inv.tax_mode,
         inv.tax_rate, inv.discount_pct, inv.status, inv.notes, inv.client_name,
         inv.client_email, inv.client_addr, inv.client_gst, total, t, t).run();

  // line items
  const stmt = env.DB.prepare(
    "INSERT INTO line_items (id,invoice_id,pos,description,qty,rate) VALUES (?,?,?,?,?,?)"
  );
  const batch = items.map((it, i) =>
    stmt.bind(uid(), id, i, it.description || it.desc || "", +it.qty || 0, +it.rate || 0));
  if (batch.length) await env.DB.batch(batch);

  return json({ ok: true, id, total });
}

async function loadInvoice(env, user, id) {
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?")
    .bind(id, user.id).first();
  if (!inv) return null;
  const { results } = await env.DB.prepare(
    "SELECT description,qty,rate,pos FROM line_items WHERE invoice_id=? ORDER BY pos"
  ).bind(id).all();
  // attach business snapshot from the user for rendering
  Object.assign(inv, {
    biz_name: user.biz_name, biz_email: user.biz_email, biz_addr: user.biz_addr,
    biz_phone: user.biz_phone, biz_gst: user.biz_gst, biz_pay: user.biz_pay,
  });
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

  const html = renderInvoiceEmail(r.inv, r.items);
  const res = await sendEmail(env, {
    to,
    subject: b.subject || `Invoice ${r.inv.number} from ${user.biz_name || "us"}`,
    html,
    text: `Invoice ${r.inv.number}. Total ${r.inv.currency} ${r.inv.total}. View the HTML version in an email client.`,
  });
  if (!res.ok) return bad("email failed: " + (res.error || res.status), 502);
  return json({ ok: true, id: res.id });
}
