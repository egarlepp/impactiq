-- v1.425.0 (security audit L8): an App Admin can disable an account. A
-- disabled user can't sign in, and their sessions and API keys are revoked
-- when they are disabled. NULL disabled_at = active.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
