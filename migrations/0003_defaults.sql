-- Per-user invoice defaults, so logged-in users don't retype common values.
-- Same denormalized-on-users pattern as the business profile.
ALTER TABLE users ADD COLUMN def_currency  TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN def_tax_mode  TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN def_tax_rate  TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN def_discount  TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN def_notes     TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN def_due_days  TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN def_prefix    TEXT DEFAULT '';
