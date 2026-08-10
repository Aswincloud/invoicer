# Invoicer

Create, preview, download, and email professional invoices in seconds.
Cloudflare Worker (static UI + `/api/*` backend) + D1 (database), with
server-side email via Resend.

## Status

| Phase | State |
|-------|-------|
| Core generator (form → live preview → PDF) | ✅ done |
| D1 schema + API (save/list/open/delete invoices) | ✅ done |
| Magic-link auth (passwordless, via Resend) | ✅ done |
| OAuth SSO (Google/GitHub/Microsoft, via auth broker) | ✅ done |
| Per-user business profile, defaults & logo | ✅ done |
| Email invoice to client (server-side Resend) | ✅ done |
| Deploy to Cloudflare (`invoicer.aswincloud.com`) | ⛔ needs CF auth |

## Run locally

The pure front-end generator needs no backend — any static server works:

```bash
python3 -m http.server 8099 --directory public
# open http://127.0.0.1:8099
```

For the full app (auth, save, email) run the Worker locally with Wrangler,
which serves `./public` as static assets and handles `/api/*`:

```bash
npm install
npm run db:migrate:local   # apply migrations to the local D1
npm run dev                # wrangler dev (reads wrangler.toml)
```

Local secrets go in `.dev.vars` (git-ignored) — see **Configuration** below.

## Features

- Form with **live preview** — every keystroke re-renders the invoice.
- **Dynamic line items** — add/remove rows, auto qty × rate.
- **Tax modes** — CGST+SGST split, single tax (IGST/VAT), or none.
- **Discount**, multi-currency (₹ uses Indian digit grouping), status badge.
- **Download PDF** via the browser print engine (client-side, offline-capable).
- **Sign in** passwordless (magic link) or via Google / GitHub / Microsoft —
  both resolve to one account per email.
- **Business profile & invoice defaults** persist in `localStorage` and, once
  signed in, **sync to your account** (D1) so they follow you across devices.
- **Business logo** — upload once, downscaled to a data-URL, shown atop the
  invoice (preview + PDF).
- **My Invoices** dashboard — save, reopen to edit, re-download, email, delete.
- **Email invoice to client** server-side via Resend.

## Architecture

```
src/               Cloudflare Worker
  index.js         router: static assets via ASSETS binding + /api/* backend
  lib.js           JSON/cookie/HMAC helpers, Resend email
  invoice-html.js  server-side invoice HTML + totals (for emailed invoices)
  oauth-routes.js  OAuth SSO via the central broker (@aswincloud/auth)
public/            static site (served by the Worker's ASSETS binding)
  index.html       form + preview shell + modals
  styles.css       screen + @media print styles
  app.js           render, totals, persistence, auth, save/email
migrations/        D1 SQL migrations
wrangler.toml      Worker config: main, [assets], D1 binding, vars
```

The Worker (`main = "src/index.js"`) handles any `/api/*` path and delegates
everything else to the static `[assets]` binding.

## Configuration

Non-secret vars live in `wrangler.toml` (`[vars]`): `APP_NAME`,
`RESEND_FROM_EMAIL`, `APP_BASE_URL`.

Secrets are **never committed**. Locally, put them in `.dev.vars`; in
production, set them with `wrangler secret put`:

| Secret | Purpose |
|--------|---------|
| `RESEND_API_KEY` | Send magic-link & invoice emails via Resend |
| `SESSION_SECRET` | HMAC key for the session cookie (falls back to `AUTH_SIGNING_KEY`) |
| `AUTH_BROKER_URL`, `RELAY_SECRET` | Enable OAuth SSO via the auth broker |
| `PRINT_RELAY_SECRET` | Signs print jobs sent to the thermal-printer relay |

Magic link works with just `RESEND_API_KEY` + a session key. SSO buttons only
appear when the broker trio (`AUTH_BROKER_URL` + `RELAY_SECRET` +
`SESSION_SECRET`) is configured.

## Deploy

Requires Cloudflare auth (`wrangler login` or `CLOUDFLARE_API_TOKEN`):

```bash
wrangler d1 create invoicer-db        # paste database_id into wrangler.toml
npm run db:migrate:remote
wrangler secret put RESEND_API_KEY
wrangler secret put SESSION_SECRET
# for SSO, also:
wrangler secret put AUTH_BROKER_URL
wrangler secret put RELAY_SECRET
# to print receipts on the thermal printer, also:
wrangler secret put PRINT_RELAY_SECRET
npm run deploy                        # wrangler deploy
```

### Printing to the thermal printer

The POS receipt button downloads a PDF. When signed in and `PRINT_ENABLED` is
`"true"`, it instead prints on the 57mm thermal printer and falls back to the
download if that fails for any reason.

The printer is Bluetooth, so the Worker cannot reach it. `POST /api/print`
HMAC-signs the PDF and forwards it to a relay running on the printer's LAN
(`tejprint-relay.py`, exposed at `PRINT_RELAY_URL` via a cloudflared tunnel),
which hands it to an ESP32-C3 BLE bridge. `PRINT_RELAY_SECRET` must match on
both ends. Set `PRINT_ENABLED = "false"` to turn the whole path off.

## Notes

- Secrets live **server-side only** — never in the browser.
- Resend requires a `User-Agent` header on API calls, or it returns `403 / 1010`.
