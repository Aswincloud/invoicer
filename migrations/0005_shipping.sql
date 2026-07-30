-- Shipping charge + mode of shipping, snapshot onto the invoice.
-- `shipping` joins the taxable value (subtotal - discount + shipping), which is
-- the standard GST treatment for freight on a composite supply.
ALTER TABLE invoices ADD COLUMN shipping      REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN shipping_mode TEXT DEFAULT '';
