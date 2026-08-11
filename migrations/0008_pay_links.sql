-- Shareable invoice links, paid online with Razorpay.
--
-- The client never signs in: the share token IS the credential, the same way
-- the shop's AP-xxxxxxxx receipt gates its thank-you page. So it is random
-- (randToken(16) — 32 hex chars) and never derived from the invoice id, which
-- appears in URLs the owner sees and would otherwise be guessable from them.
ALTER TABLE invoices ADD COLUMN share_token    TEXT;

-- The Razorpay order backing this invoice, and the amount it was created for.
--
-- rzp_amount is stored so a re-opened pay page can tell "same invoice, reuse the
-- order" from "the invoice was edited, the old order is for the wrong amount".
-- Without it, either every page load creates an orphan order, or an edited
-- invoice keeps charging the old total.
ALTER TABLE invoices ADD COLUMN rzp_order_id   TEXT;
ALTER TABLE invoices ADD COLUMN rzp_amount     INTEGER;
ALTER TABLE invoices ADD COLUMN rzp_payment_id TEXT;
ALTER TABLE invoices ADD COLUMN paid_at        INTEGER;

-- Partial, exactly like idx_invoices_source_ref in 0007: every invoice without a
-- link has NULL here, and SQLite treats NULLs as distinct in a UNIQUE index only
-- when the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_share_token
  ON invoices(share_token) WHERE share_token IS NOT NULL;

-- Also the webhook's lookup key: order.paid arrives carrying a Razorpay order
-- id and nothing else of ours, so this index is what turns it into an invoice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_rzp_order
  ON invoices(rzp_order_id) WHERE rzp_order_id IS NOT NULL;

-- Webhook idempotency, the same shape the shop uses (3d_printing 0001_init.sql).
--
-- Razorpay delivery is at-least-once and unordered, so the primary key is THEIR
-- event id: a redelivery is an INSERT OR IGNORE no-op and the handler returns
-- 200 without marking the invoice paid, or emailing anyone, a second time.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,      -- x-razorpay-event-id header
  event_type  TEXT NOT NULL,
  invoice_id  TEXT,
  received_at INTEGER NOT NULL
);
