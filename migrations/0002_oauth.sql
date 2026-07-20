-- OAuth SSO support (Google / GitHub / Microsoft) via @aswincloud/auth.
-- Links a provider identity to our existing users row. A user may link several.

CREATE TABLE IF NOT EXISTS oauth_identities (
  provider         TEXT NOT NULL,                 -- 'google' | 'github' | 'microsoft'
  provider_user_id TEXT NOT NULL,                 -- stable id from the provider
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);
