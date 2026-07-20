-- Invoicer schema — D1 (SQLite)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,          -- epoch ms
  -- denormalized business profile (the "your business" block)
  biz_name      TEXT DEFAULT '',
  biz_email     TEXT DEFAULT '',
  biz_addr      TEXT DEFAULT '',
  biz_phone     TEXT DEFAULT '',
  biz_gst       TEXT DEFAULT '',
  biz_pay       TEXT DEFAULT ''
);

-- one-time magic-link tokens (short-lived, single-use)
CREATE TABLE IF NOT EXISTS login_tokens (
  token       TEXT PRIMARY KEY,            -- random, sent in the email link
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                       -- null until consumed
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens(email);

-- server-side sessions (cookie holds the id; we also HMAC-sign it)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT DEFAULT '',
  address     TEXT DEFAULT '',
  gstin       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);

CREATE TABLE IF NOT EXISTS invoices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT REFERENCES clients(id) ON DELETE SET NULL,
  number       TEXT NOT NULL,
  issue_date   TEXT,
  due_date     TEXT,
  currency     TEXT DEFAULT '₹',
  tax_mode     TEXT DEFAULT 'gst',         -- gst | single | none
  tax_rate     REAL DEFAULT 0,
  discount_pct REAL DEFAULT 0,
  status       TEXT DEFAULT 'UNPAID',      -- UNPAID | PAID | DUE | DRAFT
  notes        TEXT DEFAULT '',
  -- snapshot of parties at creation (so past invoices don't mutate)
  client_name  TEXT DEFAULT '',
  client_email TEXT DEFAULT '',
  client_addr  TEXT DEFAULT '',
  client_gst   TEXT DEFAULT '',
  total        REAL DEFAULT 0,             -- computed grand total, cached
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS line_items (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  pos         INTEGER NOT NULL,            -- ordering
  description TEXT DEFAULT '',
  qty         REAL DEFAULT 0,
  rate        REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON line_items(invoice_id, pos);
