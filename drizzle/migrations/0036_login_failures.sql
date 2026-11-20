-- Record failed login attempts so admins can see brute-force / typo
-- patterns in the same table as successful logins. Nullable user_id
-- because a failed attempt for an unknown email has no user to link.

ALTER TABLE login_events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE login_events ADD COLUMN IF NOT EXISTS attempted_email text;
ALTER TABLE login_events ADD COLUMN IF NOT EXISTS success boolean DEFAULT true NOT NULL;
ALTER TABLE login_events ADD COLUMN IF NOT EXISTS failure_reason text;

-- Existing rows are all successful (only successes were ever inserted).
UPDATE login_events SET success = true WHERE success IS NULL;

CREATE INDEX IF NOT EXISTS login_events_success_idx ON login_events (success, created_at DESC);
