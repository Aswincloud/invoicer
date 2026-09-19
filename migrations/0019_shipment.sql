-- Shipment details on an invoice, and the WhatsApp updates sent about it.
--
-- For a customer who paid directly there is no shop order row anywhere: the
-- invoice IS the order record. So the courier and tracking number live here,
-- next to the phone the customer can be reached on, and this row is what the
-- support bot reads when that customer asks "where is my parcel?" on WhatsApp.
--
-- courier holds a ShipTrack carrier id (bluedart, delhivery, shiprocket,
-- stcourier, tpc) rather than free text, so a live status lookup is always
-- possible and the customer's tracking link always resolves.
ALTER TABLE invoices ADD COLUMN courier      TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN tracking_id  TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN shipped_at   INTEGER;
ALTER TABLE invoices ADD COLUMN delivered_at INTEGER;

-- The two follow-up messages, recorded like the invoice send (wa_message_id /
-- wa_sent_at in 0018): the Cloud API message id and when. "Did the customer get
-- the shipped message?" is answered from the row, and the delivered message is
-- sent at most once because the cron checks this before sending.
ALTER TABLE invoices ADD COLUMN wa_shipped_message_id   TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN wa_shipped_at           INTEGER;
ALTER TABLE invoices ADD COLUMN wa_delivered_message_id TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN wa_delivered_at         INTEGER;

-- What ShipTrack last said about the parcel, written by the cron. A cache, not
-- the truth: the bot asks ShipTrack live and falls back to this only when the
-- courier's site is slow or down, so the customer still gets an answer.
ALTER TABLE invoices ADD COLUMN track_status     TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN track_checked_at INTEGER;

-- The cron scans "shipped but not yet delivered" every run.
CREATE INDEX IF NOT EXISTS idx_invoices_in_transit
  ON invoices(shipped_at) WHERE shipped_at IS NOT NULL AND delivered_at IS NULL;
