-- Part-payment recorded by hand (2026-10-19).
--
-- A customer may pay part of an order up front. The money is collected outside
-- the invoicer (cash, UPI to the business's own ID); the invoice only records
-- how much has come in, prints "Received" and "Balance due" under the total,
-- and every place that asks for money with a fixed amount asks for the balance.
--
--   amount_received   rupees received so far on an unpaid invoice; 0 = none.
--                     Ignored once the invoice is PAID (fully settled) or VOID.
ALTER TABLE invoices ADD COLUMN amount_received REAL NOT NULL DEFAULT 0;
