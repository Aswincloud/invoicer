-- A packaging fee, beside shipping.
--
-- Modelled exactly like shipping: an amount and a label, SNAPSHOT onto the
-- invoice, and part of the taxable value (subtotal - discount + shipping +
-- packaging) — a charge for packing a composite supply is taxed with it, not
-- after it. The label is free text so "Secure 3-layer packaging" prints as
-- written, and an empty label renders as plain "Packaging".
--
-- Why not a line item: a line item is a product. It appears in the items list,
-- counts towards "Items N", and reads as something the customer bought. A fee
-- belongs below the subtotal with the other fees, which is where Shipping
-- already lives. Why not a generic "extra charge": because the app already has
-- one specific fee and a second specific fee is the least surprising shape.
ALTER TABLE invoices ADD COLUMN packaging       REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN packaging_label TEXT DEFAULT '';

-- Per-business defaults, so the fee that is the same on every order does not
-- have to be typed on every order. Prefilled; editable or zeroable per invoice.
ALTER TABLE businesses ADD COLUMN def_packaging       TEXT DEFAULT '';
ALTER TABLE businesses ADD COLUMN def_packaging_label TEXT DEFAULT '';
