// OAuth SSO wiring for Invoicer, built on @aswincloud/auth.
// The package authenticates the user with the provider; WE link that verified
// identity to our own `users` row (keeping our data self-contained).
import {
  startOAuth, handleOAuthCallback, configuredProviders,
} from "@aswincloud/auth";
import { uid, now, randToken, sign, cookie } from "./lib.js";

const SESSION_COOKIE = "inv_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

// Build the OAuthConfig from Worker env/secrets. Providers with no client
// credentials are simply left unconfigured (their buttons won't render).
export function oauthConfig(env) {
  return {
    stateSecret: env.AUTH_SIGNING_KEY,
    redirectUri: (p) => `${env.APP_BASE_URL}/api/auth/oauth/${p}/callback`,
    clients: {
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined,
      github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined,
      microsoft: env.MS_CLIENT_ID && env.MS_CLIENT_SECRET
        ? { clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET,
            tenantId: env.MS_TENANT_ID || undefined } : undefined,
    },
  };
}

// GET /api/auth/providers -> { providers: ["google", ...] } for the login modal.
export function providersResponse(env) {
  return new Response(
    JSON.stringify({ providers: configuredProviders(oauthConfig(env)) }),
    { headers: { "content-type": "application/json" } },
  );
}

// GET /api/auth/oauth/:provider  -> 302 to the provider consent screen.
export function oauthStart(env, provider) {
  return startOAuth(oauthConfig(env), provider);
}

// GET /api/auth/oauth/:provider/callback -> verify, link/create user, set session.
export async function oauthCallback(env, provider, request) {
  const result = await handleOAuthCallback(oauthConfig(env), provider, request);
  const fail = (why) =>
    new Response(null, { status: 302, headers: { Location: `/?auth=${why}` } });
  if (!result.ok) return fail("oauth_" + result.error.split(":")[0]);

  const { providerUserId, email } = result.user;

  // 1) already linked? -> that user
  let userId = (await env.DB.prepare(
    "SELECT user_id FROM oauth_identities WHERE provider=? AND provider_user_id=?"
  ).bind(provider, providerUserId).first())?.user_id;

  // 2) not linked, but a user with this email exists -> link to them
  if (!userId) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE email=?")
      .bind(email).first();
    if (u) userId = u.id;
  }

  // 3) brand new -> create the user
  if (!userId) {
    userId = uid();
    await env.DB.prepare("INSERT INTO users (id,email,created_at) VALUES (?,?,?)")
      .bind(userId, email, now()).run();
  }

  // record the identity link (ignore if it already exists)
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oauth_identities (provider,provider_user_id,user_id,email,created_at) VALUES (?,?,?,?,?)"
  ).bind(provider, providerUserId, userId, email, now()).run();

  // create our own session (same mechanism as magic-link)
  const sid = randToken(32);
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)"
  ).bind(sid, userId, now(), now() + SESSION_TTL).run();
  const signed = await sign(sid, env.AUTH_SIGNING_KEY);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/?auth=ok",
      "Set-Cookie": cookie(SESSION_COOKIE, signed, { maxAge: SESSION_TTL / 1000 }),
    },
  });
}
