-- One account, several businesses.
--
-- The business was modelled as columns on `users` — biz_name, biz_gst, biz_pay,
-- the logo, and the def_* invoice defaults beside them. That is exactly one
-- business per login, and Aswin runs two off this account: AswinCloud (services,
-- GST registered) and Aswin3DPrints (products, sold over a counter). They need
-- different names, different GSTINs, different payment details, their own
-- invoice-number prefixes and their own tax treatment.
--
-- The important part of this migration is the second half, not the first.
--
-- Invoices snapshot the CLIENT at creation — client_name, client_gst and the
-- rest, with 0001_init's comment saying why: "so past invoices don't mutate".
-- The business was never snapshotted. It is merged in from the current user row
-- at render time, in five different places. With one business that is harmless;
-- editing your own address updates your own past invoices, which is usually what
-- you meant. With two businesses it is a correctness bug: reprinting last
-- month's AswinCloud invoice while 3DPrints happened to be selected would put
-- the wrong trading name, the wrong GSTIN and the wrong bank details on a tax
-- document.
--
-- So invoices get a business_id, and every existing invoice is backfilled to the
-- business built from its owner's current details. After this migration no
-- invoice has a NULL business_id, which is what lets the renderers JOIN without
-- carrying a legacy fallback path forever.
--
-- users.biz_* and users.def_* are deliberately LEFT IN PLACE. This migration
-- reads them, dropping columns in SQLite means rebuilding the table, and a
-- rollback wants them intact. Reads move to `businesses`; those columns simply
-- stop being consulted.

CREATE TABLE IF NOT EXISTS businesses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- identity, same names as the columns they came from so the renderers, which
  -- already read biz_name / biz_gst / biz_pay, need no change at all
  biz_name     TEXT DEFAULT '',
  biz_email    TEXT DEFAULT '',
  biz_addr     TEXT DEFAULT '',
  biz_phone    TEXT DEFAULT '',
  biz_gst      TEXT DEFAULT '',
  biz_pay      TEXT DEFAULT '',
  biz_logo     TEXT DEFAULT '',

  -- "scan for other products and order online". Empty url means no QR is drawn
  -- anywhere, so a business without a shop prints exactly what it prints today.
  qr_url       TEXT DEFAULT '',
  qr_caption   TEXT DEFAULT '',

  -- per-business invoice defaults: 3DPrints wants its own prefix and may be
  -- non-GST while AswinCloud is at 18%
  def_currency TEXT DEFAULT '',
  def_tax_mode TEXT DEFAULT '',
  def_tax_rate TEXT DEFAULT '',
  def_discount TEXT DEFAULT '',
  def_notes    TEXT DEFAULT '',
  def_due_days TEXT DEFAULT '',
  def_prefix   TEXT DEFAULT '',

  -- which one a new invoice starts on, and which one the shop ingest path bills
  -- under. Exactly one per user is expected; the app enforces it on write.
  is_default   INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_businesses_user ON businesses(user_id);

-- Every existing user becomes one business carrying their current details, so
-- nothing about their invoices changes on the day this ships.
INSERT INTO businesses (
  id, user_id, biz_name, biz_email, biz_addr, biz_phone, biz_gst, biz_pay, biz_logo,
  def_currency, def_tax_mode, def_tax_rate, def_discount, def_notes, def_due_days,
  def_prefix, is_default, created_at
)
SELECT
  lower(hex(randomblob(16))),
  u.id,
  COALESCE(u.biz_name, ''), COALESCE(u.biz_email, ''), COALESCE(u.biz_addr, ''),
  COALESCE(u.biz_phone, ''), COALESCE(u.biz_gst, ''), COALESCE(u.biz_pay, ''),
  COALESCE(u.biz_logo, ''),
  COALESCE(u.def_currency, ''), COALESCE(u.def_tax_mode, ''), COALESCE(u.def_tax_rate, ''),
  COALESCE(u.def_discount, ''), COALESCE(u.def_notes, ''), COALESCE(u.def_due_days, ''),
  COALESCE(u.def_prefix, ''),
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.user_id = u.id);

ALTER TABLE invoices ADD COLUMN business_id TEXT REFERENCES businesses(id);

-- Backfill by owner. Every invoice already belongs to exactly one user, and
-- that user now has exactly one business, so this is unambiguous.
UPDATE invoices
   SET business_id = (
     SELECT b.id FROM businesses b
      WHERE b.user_id = invoices.user_id AND b.is_default = 1
      LIMIT 1
   )
 WHERE business_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices(business_id);
