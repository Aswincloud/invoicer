-- Saved customers, so a returning customer's name, mobile, email, address and
-- GSTIN can be picked instead of retyped (2026-11-01).
--
-- One row per customer per account, keyed by `ckey`: the E.164 mobile when
-- there is one ("p:919876543210"), else the lower-cased name ("n:priya r").
-- Upserted from every invoice save, so it follows the latest details a
-- customer gave; seeded below from every invoice already saved.
CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  ckey        TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  addr        TEXT NOT NULL DEFAULT '',
  gst         TEXT NOT NULL DEFAULT '',
  invoices    INTEGER NOT NULL DEFAULT 0,
  last_used   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_key ON customers(user_id, ckey);

-- Seed: replay every saved invoice, oldest first, through the SAME upsert
-- rememberCustomer() runs on each save (src/customers.js), so the seeded list
-- is exactly what saving those invoices one by one would have built: the
-- latest name wins, a blank later field never erases an earlier one, and each
-- non-void invoice counts once. Name keys collapse internal whitespace the way
-- customerKey() does; SQLite has no regex, so runs of up to 16 spaces are
-- folded by repeated replace().
INSERT INTO customers (id, user_id, ckey, name, phone, email, addr, gst, invoices, last_used, created_at, updated_at)
SELECT lower(hex(randomblob(16))), user_id,
       CASE WHEN COALESCE(client_phone,'')<>'' THEN 'p:' || client_phone
            ELSE 'n:' || lower(replace(replace(replace(replace(replace(trim(client_name),'  ',' '),'  ',' '),'  ',' '),'  ',' '),'  ',' ')) END,
       substr(trim(client_name),1,120), COALESCE(client_phone,''),
       substr(COALESCE(client_email,''),1,160), substr(COALESCE(client_addr,''),1,500), substr(COALESCE(client_gst,''),1,20),
       1, created_at, created_at, created_at
  FROM invoices
 WHERE status<>'VOID' AND trim(COALESCE(client_name,''))<>''
 ORDER BY created_at
ON CONFLICT(user_id, ckey) DO UPDATE SET
  name  = excluded.name,
  email = CASE WHEN excluded.email<>'' THEN excluded.email ELSE customers.email END,
  addr  = CASE WHEN excluded.addr<>''  THEN excluded.addr  ELSE customers.addr  END,
  gst   = CASE WHEN excluded.gst<>''   THEN excluded.gst   ELSE customers.gst   END,
  invoices = customers.invoices + 1,
  last_used = excluded.last_used, updated_at = excluded.updated_at;
