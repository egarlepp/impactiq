-- v1.116.0: one-shot password-reset tokens + seed the password_reset
-- email rule so the template editor can customise it before the
-- flow lights up.
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"  text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "expires_at"  timestamptz NOT NULL,
  "used_at"     timestamptz,
  "ip"          text,
  "user_agent"  text
);

CREATE INDEX IF NOT EXISTS "prt_user_idx"  ON "password_reset_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "prt_token_idx" ON "password_reset_tokens" ("token_hash");

INSERT INTO "email_rules" ("key", "name", "description", "is_active") VALUES
  ('password_reset', 'Password reset', 'Sent when a user requests a reset from the login page. Includes a one-shot link that expires in 60 minutes. Users on Okta / SSO accounts are silently skipped (no user enumeration).', true)
ON CONFLICT ("key") DO NOTHING;
