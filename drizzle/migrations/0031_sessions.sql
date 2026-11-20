-- Server-side sessions. Previously the session cookie was a stateless
-- HMAC-signed payload; that made revocation impossible without rotating the
-- global secret. Every new session now inserts a row here; requireAuth
-- verifies the hashed token against this table.
--
-- Older HMAC-only cookies keep working during a rollover period (auth.ts
-- falls through to the legacy verifier if no row matches), then get replaced
-- on next request via a soft rotation.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  ip              text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id, last_used_at DESC);

-- Suspicious-login detection. Every successful login writes a row; a helper
-- compares each new row to prior rows for the same user and flags "new IP"
-- (not previously seen for this user in the last 90 days) as suspicious.
CREATE TABLE login_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method          text NOT NULL,
  ip              text,
  user_agent      text,
  is_suspicious   boolean NOT NULL DEFAULT false,
  alert_sent_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_user_created ON login_events (user_id, created_at DESC);
