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

-- Seed: newest invoice per customer wins for each field. Phone-keyed first.
INSERT OR IGNORE INTO customers (id, user_id, ckey, name, phone, email, addr, gst, invoices, last_used, created_at, updated_at)
SELECT lower(hex(randomblob(16))), i.user_id, 'p:' || i.client_phone,
       i.client_name, i.client_phone, COALESCE(i.client_email,''), COALESCE(i.client_addr,''), COALESCE(i.client_gst,''),
       (SELECT COUNT(*) FROM invoices j WHERE j.user_id=i.user_id AND j.client_phone=i.client_phone AND j.status<>'VOID'),
       i.created_at, i.created_at, i.created_at
  FROM invoices i
 WHERE i.status<>'VOID' AND COALESCE(i.client_phone,'')<>'' AND trim(COALESCE(i.client_name,''))<>''
   AND i.created_at = (SELECT MAX(k.created_at) FROM invoices k WHERE k.user_id=i.user_id AND k.client_phone=i.client_phone AND k.status<>'VOID');
INSERT OR IGNORE INTO customers (id, user_id, ckey, name, phone, email, addr, gst, invoices, last_used, created_at, updated_at)
SELECT lower(hex(randomblob(16))), i.user_id, 'n:' || lower(trim(i.client_name)),
       trim(i.client_name), '', COALESCE(i.client_email,''), COALESCE(i.client_addr,''), COALESCE(i.client_gst,''),
       (SELECT COUNT(*) FROM invoices j WHERE j.user_id=i.user_id AND lower(trim(j.client_name))=lower(trim(i.client_name)) AND COALESCE(j.client_phone,'')='' AND j.status<>'VOID'),
       i.created_at, i.created_at, i.created_at
  FROM invoices i
 WHERE i.status<>'VOID' AND COALESCE(i.client_phone,'')='' AND trim(COALESCE(i.client_name,''))<>''
   AND i.created_at = (SELECT MAX(k.created_at) FROM invoices k WHERE k.user_id=i.user_id AND lower(trim(k.client_name))=lower(trim(i.client_name)) AND COALESCE(k.client_phone,'')='' AND k.status<>'VOID');
