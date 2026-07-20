# Invoicer

Create, preview, download, and email professional invoices in seconds.
Cloudflare Pages (static UI) + Pages Functions (API) + D1 (database), with
server-side email via Resend.

## Status

| Phase | State |
|-------|-------|
| Core generator (form → live preview → PDF) | ✅ done |
| D1 schema + API (save/list invoices & clients) | 🔜 |
| Magic-link auth (passwordless, via Resend) | 🔜 |
| Email invoice to client (server-side Resend) | 🔜 |
| Deploy to Cloudflare (`invoices.aswincloud.com`) | ⛔ needs CF auth |

## Run locally

No backend needed for the core generator:

```bash
# any static server works
python3 -m http.server 8099 --directory public
# open http://127.0.0.1:8099
```

Or with the Cloudflare toolchain (once D1 is added):

```bash
npm install
npm run dev            # wrangler pages dev
```

## Features (core, shipping now)

- Form with **live preview** — every keystroke re-renders the invoice.
- **Dynamic line items** — add/remove rows, auto qty × rate.
- **Tax modes** — CGST+SGST split, single tax (IGST/VAT), or none.
- **Discount**, multi-currency (₹ uses Indian digit grouping), status badge.
- **Business profile persists** in `localStorage` — enter it once.
- **Download PDF** via the browser print engine (client-side, offline-capable).

## Architecture

```
public/            static site (Pages)
  index.html       form + preview shell
  styles.css       screen + @media print styles
  app.js           render, totals, persistence, print
functions/api/     Pages Functions (D1-backed API) — WIP
migrations/        D1 SQL migrations — WIP
```

## Deploy (later)

Requires Cloudflare auth (`wrangler login` or `CLOUDFLARE_API_TOKEN`):

```bash
wrangler d1 create invoicer-db          # paste id into wrangler.toml
npm run db:migrate:remote
wrangler pages secret put RESEND_API_KEY
npm run deploy
```

## Notes

- Secrets (`RESEND_API_KEY`) live **server-side only** (Pages secret) — never in the browser.
- Resend requires a `User-Agent` header on API calls, or it returns `403 / 1010`.
