-- Personal API keys for programmatic read-only access. Stored as scrypt hash
-- (never plaintext); the key_prefix is the first 8 chars of the key, kept in
-- clear so the user can identify a key in the UI without unhashing it.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_hash      text NOT NULL,
  key_salt      text NOT NULL,
  key_prefix    text NOT NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user ON api_keys (user_id);
CREATE INDEX api_keys_prefix ON api_keys (key_prefix);
