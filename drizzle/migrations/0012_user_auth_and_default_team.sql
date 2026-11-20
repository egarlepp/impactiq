-- User default team, default-admin flag, and auth-method preference.
-- These let an admin choose how a user signs in (password, Okta, or both),
-- pin a "default" app admin that can't be removed from a team, and capture
-- which team a user belongs to even when they have all-teams visibility.

-- default_team_id: nullable so existing users aren't forced into a team
-- on upgrade; new users created through the admin form will get this set.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "default_team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;

-- is_default_admin: marks ONE app admin as the "default" — UI hides the
-- delete affordance and the API rejects role/admin changes that would clear it.
-- We don't enforce uniqueness at the DB layer because flipping the flag
-- between rows in a single transaction is easier without a deferrable constraint;
-- the service layer enforces "exactly one".
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_default_admin" boolean NOT NULL DEFAULT false;

-- auth_method: how this user can sign in.
--   'password' — local password only; Okta sign-in for this email is rejected
--   'okta'     — Okta only; password login is rejected, no password is stored
--   'both'     — either path works (default; matches existing behavior)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "auth_method" text NOT NULL DEFAULT 'both';

ALTER TABLE "users"
  ADD CONSTRAINT "users_auth_method_check"
  CHECK ("auth_method" IN ('password', 'okta', 'both'));

-- Backfill: promote the first existing app admin to default admin so the
-- "must always have one" invariant holds immediately after migration.
UPDATE "users"
SET "is_default_admin" = true
WHERE "id" = (
  SELECT "id" FROM "users" WHERE "is_app_admin" = true
  ORDER BY "created_at" ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "users" WHERE "is_default_admin" = true);
