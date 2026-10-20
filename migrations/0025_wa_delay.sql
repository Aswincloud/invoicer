-- WhatsApp delay notice (order_delay_notice, 2026-10-20): when it was last
-- sent, so the dialog can say "already sent" before a second one goes out.
ALTER TABLE invoices ADD COLUMN wa_delay_message_id TEXT;
ALTER TABLE invoices ADD COLUMN wa_delay_at INTEGER;
