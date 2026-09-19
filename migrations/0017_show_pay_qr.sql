-- Whether this invoice invites payment by QR.
--
-- The "Scan to pay" QR appears on an unpaid invoice automatically. Sometimes it
-- should not: a quote, a bill the customer is settling in cash at the counter,
-- an order being paid through a link already sent. So each invoice carries its
-- own switch, ON by default, snapshotted the way round_off is - a later render
-- of a sent invoice must not grow or lose a QR because the form changed.
--
-- PAID and VOID never show the QR regardless; this only ever narrows.
ALTER TABLE invoices ADD COLUMN show_pay_qr INTEGER DEFAULT 1;
