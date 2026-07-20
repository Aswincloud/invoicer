// OAuth SSO for Invoicer via the central broker (auth.aswincloud.com).
//
// Invoicer no longer holds its own Google/GitHub/Microsoft OAuth clients. The
// broker owns ONE app per provider, authenticates the user, and relays the
// verified email back here — signed with our per-site RELAY_SECRET. We verify
// that relay, apply the ACCESS_MODE policy, then find/create the user in OUR D1
// and mint the same D1-backed session that magic-link uses (so both sign-in
// methods share one session scheme).
//
//   GET /api/auth/oauth/:provider          → set signed nonce cookie, 302 to broker start
//   GET /api/auth/oauth/:provider/callback → verify relay + nonce + policy, create session
//   GET /api/auth/providers                → proxy the broker's per-site provider list
//
// Contract mirrors the reference site (Aswincloud/status-page src/auth.ts):
//   {BROKER}/api/oauth/{provider}/start?site=&return=&nonce=  → 302 back with ?relay= | ?relay_error=
import {
  verifyRelay, signToken, verifyToken, emailAllowed, parseAccessMode,
} from "@aswincloud/auth";
import { uid, now, randToken, sign, cookie, parseCookies } from "./lib.js";

const SESSION_COOKIE = "inv_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;      // 30 days (ms)
const NONCE_COOKIE = "inv_oauth_nonce";
const NONCE_PURPOSE = "broker_nonce";
const NONCE_TTL_SECONDS = 10 * 60;                  // 10 min
const SITE_ID = "invoicer";                         // how we're registered with the broker
const KNOWN_PROVIDERS = ["google", "github", "microsoft"];

// Sign-in is wired only when the broker trio of secrets is present.
export const ssoConfigured = (env) =>
  !!(env.AUTH_BROKER_URL && env.RELAY_SECRET && env.SESSION_SECRET);

const brokerBase = (env) => env.AUTH_BROKER_URL.replace(/\/$/, "");

// GET /api/auth/providers → { providers: [{id,name}, ...] }.
// Proxy the broker's list (registered-for-this-site ∩ configured-on-broker) so a
// provider button appears/disappears with no change here. Empty when unconfigured.
export async function providersResponse(env) {
  const headers = { "content-type": "application/json", "cache-control": "max-age=300" };
  if (!ssoConfigured(env)) return new Response(JSON.stringify({ providers: [] }), { headers });
  try {
    const r = await fetch(`${brokerBase(env)}/api/oauth/providers?site=${SITE_ID}`,
      { headers: { accept: "application/json" } });
    if (!r.ok) return new Response(JSON.stringify({ providers: [] }), { headers });
    const body = await r.json();
    const list = Array.isArray(body.providers) ? body.providers : [];
    return new Response(JSON.stringify({ providers: list }), { headers });
  } catch {
    return new Response(JSON.stringify({ providers: [] }), { headers });
  }
}

// GET /api/auth/oauth/:provider → 302 to the broker's start endpoint.
export async function oauthStart(env, provider) {
  if (!ssoConfigured(env))
    return new Response(null, { status: 302, headers: { Location: "/?auth=config" } });

  const prov = KNOWN_PROVIDERS.includes(provider) ? provider : "google";

  // Fresh nonce binds this attempt to the relay we get back; carried in a signed,
  // short-lived cookie and handed to the broker as ?nonce.
  const nonce = randToken(16);
  const nonceTok = await signToken(env.SESSION_SECRET, nonce, NONCE_PURPOSE, NONCE_TTL_SECONDS);

  const ret = `${env.APP_BASE_URL}/api/auth/oauth/${prov}/callback`;
  const start = new URL(`${brokerBase(env)}/api/oauth/${prov}/start`);
  start.searchParams.set("site", SITE_ID);
  start.searchParams.set("return", ret);
  start.searchParams.set("nonce", nonce);

  return new Response(null, {
    status: 302,
    headers: {
      Location: start.toString(),
      "Set-Cookie": cookie(NONCE_COOKIE, nonceTok, { maxAge: NONCE_TTL_SECONDS }),
    },
  });
}

// GET /api/auth/oauth/:provider/callback → verify relay, apply policy, session.
export async function oauthCallback(env, provider, request) {
  const clearNonce = cookie(NONCE_COOKIE, "", { del: true });
  const fail = (why) => new Response(null, {
    status: 302,
    headers: { Location: `/?auth=${why}`, "Set-Cookie": clearNonce },
  });

  if (!ssoConfigured(env)) return fail("config");

  const url = new URL(request.url);
  const relayError = url.searchParams.get("relay_error");
  if (relayError)
    return fail(relayError === "email_not_verified" ? "oauth_unverified" : "oauth_exchange");
  const relay = url.searchParams.get("relay");
  if (!relay) return fail("oauth_state");

  // Verify the broker's relay token with our per-site secret + nonce echo.
  const claims = await verifyRelay(env.RELAY_SECRET, relay);
  if (!claims) return fail("oauth_state");
  const nonceTok = parseCookies(request)[NONCE_COOKIE];
  const expectedNonce = nonceTok
    ? await verifyToken(env.SESSION_SECRET, nonceTok, NONCE_PURPOSE) : null;
  if (!expectedNonce || expectedNonce !== claims.nonce) return fail("oauth_state");

  // Access policy (invoicer = "public": any provider-verified email).
  const allowed = emailAllowed({
    mode: parseAccessMode(env.ACCESS_MODE),
    email: claims.email,
    owners: env.OWNER_EMAILS,
    domains: env.ACCESS_DOMAINS,
  });
  if (!allowed) return fail("oauth_denied");

  const email = claims.email;
  const provId = claims.provider || provider;
  const providerUserId = claims.providerUserId || email; // fallback keeps link stable

  // Link the verified identity to OUR users table (same logic as before).
  // 1) already linked?
  let userId = (await env.DB.prepare(
    "SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?"
  ).bind(provId, providerUserId).first())?.user_id;
  // 2) match by email?
  if (!userId) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (u) userId = u.id;
  }
  // 3) brand new?
  if (!userId) {
    userId = uid();
    await env.DB.prepare("INSERT INTO users (id,email,created_at) VALUES (?,?,?)")
      .bind(userId, email, now()).run();
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oauth_identities (provider,provider_user_id,user_id,email,created_at) VALUES (?,?,?,?,?)"
  ).bind(provId, providerUserId, userId, email, now()).run();

  // Our own D1-backed session (shared with magic-link), signed with SESSION_SECRET.
  const sid = randToken(32);
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(sid, userId, now(), now() + SESSION_TTL).run();
  const signed = await sign(sid, env.SESSION_SECRET || env.AUTH_SIGNING_KEY);

  const headers = new Headers({ Location: "/?auth=ok" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, signed, { maxAge: SESSION_TTL / 1000 }));
  headers.append("Set-Cookie", clearNonce);
  return new Response(null, { status: 302, headers });
}
