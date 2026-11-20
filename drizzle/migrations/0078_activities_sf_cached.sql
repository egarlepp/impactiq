-- v1.97.0: cache SF Account + Assigned SE on the activity itself so the
-- card doesn't rely on a live SF read to render them. Populated at save
-- time from the ActivityForm's SF picker / Assigned SE picker; a later
-- resync can refresh them but they are the display source of truth.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "sf_account_id" text;
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "sf_account_name" text;
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "sf_assigned_se_name" text;
