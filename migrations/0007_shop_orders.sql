-- Invoices raised automatically from a paid shop order.
--
-- These are ordinary rows in `invoices` — same columns, same rendering, same
-- dashboard, same re-send button. Two columns are all that is added.

-- Where the invoice came from: 'shop' for one raised by 3d-prints.aswincloud.com,
-- NULL for one Aswin typed into the form. Lets the dashboard tell them apart
-- without inferring it from the number format.
ALTER TABLE invoices ADD COLUMN source TEXT;

-- The originating order's receipt (AP-xxxxxxxx). This is the idempotency key.
ALTER TABLE invoices ADD COLUMN source_ref TEXT;

-- THE guarantee that a redelivered payment webhook cannot raise a second invoice
-- or send a second email.
--
-- In the database rather than in the handler, for the same reason
-- coupon_redemptions(order_id) is: a check in application code races with itself
-- under concurrent delivery, and Razorpay can and does deliver the same event
-- twice. A UNIQUE index cannot race.
--
-- Partial, because every hand-made invoice has source_ref NULL and SQLite would
-- otherwise allow only one of them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_source_ref
  ON invoices(source_ref) WHERE source_ref IS NOT NULL;
