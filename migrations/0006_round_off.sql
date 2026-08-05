-- Round the grand total to a whole currency unit, snapshot onto the invoice.
-- Standard GST presentation (CGST Act s.170): the taxable value and each tax
-- row stay exact, and a visible "Round off" line absorbs the paise.
--
-- Defaults to 0, not 1: existing invoices were saved with exact totals and
-- their stored `total` column reflects that, so turning rounding on for them
-- retroactively would make the re-rendered figures disagree with what was
-- saved and already sent to a client.
ALTER TABLE invoices ADD COLUMN round_off INTEGER DEFAULT 0;
