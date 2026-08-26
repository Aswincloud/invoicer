-- A gift card handed to the customer as a thank-you.
--
-- Aswin creates an Amazon Pay gift card and gives the code away with the bill.
-- It is a present, not a payment and not a charge, and the schema says so:
--
--   * Its own columns, NOT a line item. A line item would land in the subtotal,
--     the taxable value and the item count, and a free gift is none of those. A
--     zero-priced line would stay out of the total but still be counted as
--     something the customer was handed, which is a different lie.
--   * Nothing here is read by computeTotals. The gift cannot move the amount
--     due, in either direction, by construction rather than by care.
--
-- PER INVOICE, because a code is single-use. Storing it here also means a
-- reprint shows the same code rather than a fresh blank, and there is a record
-- of which customer received which card.
--
-- gift_amount is only what gets PRINTED beside the code ("Rs. 100 gift card").
-- It is not money owed and never enters a total.
ALTER TABLE invoices ADD COLUMN gift_code TEXT DEFAULT '';
ALTER TABLE invoices ADD COLUMN gift_amount REAL DEFAULT 0;
