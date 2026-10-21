-- WhatsApp "out for delivery" (order_out_for_delivery, 2026-10-21). Sent once
-- by the half-hourly delivery cron when ShipTrack first reports the parcel
-- out_for_delivery; these record that it went, so it is never sent twice.
ALTER TABLE invoices ADD COLUMN wa_ofd_message_id TEXT;
ALTER TABLE invoices ADD COLUMN wa_ofd_at INTEGER;
