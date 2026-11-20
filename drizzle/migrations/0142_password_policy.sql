-- v1.323.0: password reuse history + 90-day expiry policy, scoped entirely
-- to accounts whose authMethod is exactly 'password' (Okta/Azure SSO
-- accounts, and 'both'/all-login-options accounts, are exempt — see
-- CLAUDE.md §4/§5).
ALTER TABLE users
  ADD COLUMN password_changed_at timestamptz;
--> statement-breakpoint

-- Backfill: start the 90-day clock at deploy time for every account that
-- already has a password set. There is no real history of when it was
-- last changed, and backdating to created_at would immediately expire
-- long-lived accounts on rollout — starting fresh is the kinder default.
UPDATE users SET password_changed_at = now() WHERE password_hash IS NOT NULL;
--> statement-breakpoint

CREATE TABLE password_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX password_history_user_id_idx ON password_history(user_id);
