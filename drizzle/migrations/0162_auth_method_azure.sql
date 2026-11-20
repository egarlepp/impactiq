-- v1.415.0: users.auth_method has accepted 'azure' (Azure-only sign-in) in
-- the app since v1.323, but the CHECK constraint from 0012 still allowed only
-- password / okta / both, so saving a user as Azure-only failed in the
-- database. Recreate the constraint with all four values.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_auth_method_check";
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_auth_method_check"
  CHECK ("auth_method" IN ('password', 'okta', 'azure', 'both'));
