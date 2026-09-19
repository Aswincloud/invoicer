-- Sending an invoice over WhatsApp.
--
-- The customer's number, snapshot onto the invoice like every other client
-- detail. E.164 without the plus ("919xxxxxxxxx") - the shape the Cloud API
-- takes and the one shape that cannot be misread as a local number.
ALTER TABLE invoices ADD COLUMN client_phone TEXT DEFAULT '';

-- What was sent. The Cloud API returns a message id on acceptance; keeping it
-- (and when) is what makes "did this go out?" answerable from the row, and is
-- the hook a delivery-status webhook would update later.
ALTER TABLE invoices ADD COLUMN wa_message_id TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN wa_sent_at    INTEGER;
