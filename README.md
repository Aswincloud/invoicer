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
- **Editing edits.** Reopening an invoice and saving updates it rather than
  creating another; a **paid** invoice is locked, and invoice numbers are unique
  per account. Cancel one with the **VOID** status — the record and its number
  survive, and a replacement may reuse the number.
- **Email invoice to client** server-side via Resend.
- **Shareable pay link** — one URL the client opens to review the invoice and
  pay it with Razorpay; the invoice marks itself **PAID** when the money lands.

## Architecture

```
scripts/           one-off maintenance (dedupe-invoices.mjs)
src/               Cloudflare Worker
  index.js         router: static assets via ASSETS binding + /api/* backend
  lib.js           JSON/cookie/HMAC helpers, Resend email
  invoice-html.js  server-side invoice HTML + totals (email, PDF and pay page)
  oauth-routes.js  OAuth SSO via the central broker (@aswincloud/auth)
  razorpay.js      Razorpay REST client + the two signature checks
  pay.js           /i/<token> public page, order/verify, order.paid webhook
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
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API key pair, for pay links |
| `RAZORPAY_WEBHOOK_SECRET` | A **different** string — signs the webhook body |
| `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN` | Meta Cloud API: the WhatsApp number messages go out from, and a permanent System User token. Use the number Chatwoot answers on, or replies land with the wrong bot |
| `WA_TEMPLATE_CONFIRMED`, `WA_TEMPLATE_SHIPPED`, `WA_TEMPLATE_DELIVERED` | Optional; default to the `order_confirmed_new` / `order_shipped_link` / `order_delivered_new` templates on the WABA |
| `WA_SHIPPED_BUTTON_BASE` | Optional; the fixed URL prefix of `order_shipped_link`'s button, default `https://shiptrack.aswincloud.com/track/`. The message sends the rest of the tracking link (`<carrier>/<awb>`) as the button's dynamic suffix |
| `INVOICER_CHAT_SECRET` | Shared with the support bot; signs `POST /api/chat/shipments` |

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
# for shareable pay links, also:
wrangler secret put RAZORPAY_KEY_ID
wrangler secret put RAZORPAY_KEY_SECRET
wrangler secret put RAZORPAY_WEBHOOK_SECRET
npm run deploy                        # wrangler deploy
```

### Shareable pay links

**Copy link** on a saved invoice gives you a URL like
`https://invoicer.aswincloud.com/i/<32-hex>`. The client opens it, reviews the
items, and pays with Razorpay Checkout without leaving the page or creating an
account. The **Email** button includes the same link as a Pay button.

Two rules the code is built around:

1. **The amount is computed server-side** from `computeTotals()` — the same call
   that renders the total the client is reading. Nothing the browser sends is
   used, so the charge cannot disagree with the page.
2. **Only the webhook marks an invoice PAID.** The checkout callback is
   signature-verified and updates the UI, but Razorpay's server-to-server
   `order.paid` is the sole authority on status.

The token is the credential — anyone holding the link can view and pay the
invoice, which is the point. It is minted on first share (never at save time,
so an invoice that is never shared has no link) and is unrelated to the
invoice id.

After setting the secrets, add a webhook in the Razorpay dashboard pointing at
`https://invoicer.aswincloud.com/api/webhook/razorpay` for `order.paid` (and
`payment.failed`), using the value you set as `RAZORPAY_WEBHOOK_SECRET`. This is
a **second** webhook alongside the shop's; Razorpay supports several, each with
its own secret, and the shop's is unaffected. Invoicer receives the shop's
events too and ignores any order it does not own.

Set `PAY_ENABLED = "false"` to stop taking payments — links still open and
invoices still render, only the Pay button goes away. Razorpay settles in INR,
so the button appears on `₹` invoices only.

### Printing to the thermal printer

Two separate buttons, so neither can surprise you:

- **POS receipt** — always downloads the 57mm PDF, signed in or not.
- **Print receipt** — sends it to the thermal printer. Only shown when signed
  in, and only works for an address in `PRINT_ALLOWED_EMAILS` (defaults to
  `INVOICE_OWNER_EMAIL`). Signing in is not authorisation to print: anyone can
  create an account, so the allowlist is what gates the printer.

The button waits for the paper to actually come out, so "Printed ✓" means
printed rather than queued. If it fails for any reason it downloads the PDF and
says why — a printer that's off or out of paper costs a download, not the
receipt.

The printer is Bluetooth, so the Worker cannot reach it. `POST /api/print`
HMAC-signs the PDF and forwards it to a relay running on the printer's LAN
(`tejprint-relay.py`, exposed at `PRINT_RELAY_URL` via a cloudflared tunnel),
which hands it to an ESP32-C3 BLE bridge. `PRINT_RELAY_SECRET` must match on
both ends. Set `PRINT_ENABLED = "false"` to turn the whole path off.

### WhatsApp messages and shipments

For a customer who paid directly there is no shop order anywhere: **the invoice
is the order record.** It carries the customer's phone, and from `0019` the
courier and tracking number too.

The **WhatsApp ▾** button on a paid invoice is a menu of three messages. Each
opens a modal with the recipient and the **exact text** the customer will read,
and nothing is sent until you confirm:

| Item | Template | Params | Also |
|---|---|---|---|
| Send invoice | `order_confirmed_new` | customer, order no., business | **DOCUMENT header**: the invoice PDF, fetched by Meta from `/i/<token>.pdf` |
| Share tracking | `order_shipped_link` | customer, order no., business, courier, tracking id + URL button → ShipTrack | records courier + tracking on the invoice **before** sending |
| Send delivered | `order_delivered_new` | customer, order no., business | stamps `delivered_at` |

Preview and send build the same template params from the same code
(`src/wa.js`, `src/shipment.js`), so the two cannot disagree. The preview text
is a copy of each template's wording; if a template is edited in Meta Business
Manager, update `TEMPLATE_TEXT` in `src/shipment.js` too. All three are
business-initiated messages and must use Meta-**approved** templates; until a
template is approved a send fails with Meta's own message in the modal.

`order_shipped_link`'s button is a dynamic URL button whose fixed prefix is
`https://shiptrack.aswincloud.com/track/` (the message supplies `<carrier>/<awb>`).
If it is ever recreated with a different prefix, set `WA_SHIPPED_BUTTON_BASE`. Paid invoices
stay edit-locked; `POST /api/invoices/:id/whatsapp` is the one deliberate way
through that lock, for shipment fields only.

**Delivered is detected automatically.** A cron (`[triggers]` in
`wrangler.toml`, every 30 min) asks ShipTrack's public API about every parcel
shipped but not delivered, records what it said in `track_status`, and when one
has arrived stamps the invoice and sends `order_delivered_new` once (guarded by
`wa_delivered_at`). A courier site being down costs nothing but a retry.

**`POST /api/chat/shipments`** answers the support bot's "where is my parcel?"
on WhatsApp. HMAC-SHA256 over the raw body with `INVOICER_CHAT_SECRET`, a
timestamp within ±5 min, and the answer is scoped to the account in
`INVOICE_OWNER_EMAIL` — read from config, never the request — so however it is
called it cannot return another user's invoices. The customer is selected by the
phone Meta verified as the WhatsApp sender.

Migration note: `d1 migrations apply --remote` failed in Sept 2026 because
`0015`–`0018` had been applied by hand and never recorded in `d1_migrations`.
They were recorded (metadata only, every column verified present first) and
`0019` applied normally. If it happens again, that is the fix — not re-running
the SQL.

## Notes

- Secrets live **server-side only** — never in the browser.
- Resend requires a `User-Agent` header on API calls, or it returns `403 / 1010`.
