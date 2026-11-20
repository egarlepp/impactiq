-- Performance indexes for the dashboard hot paths. `activities` previously had
-- no secondary indexes, so every dashboard panel sequential-scanned the whole
-- table. Partial indexes match the near-universal filter (submitted +
-- not-archived) so they stay small and cover both the range filter and the
-- ORDER BY. NOTE: on a large live table, apply these with CREATE INDEX
-- CONCURRENTLY out-of-band instead (cannot run inside the migration txn).

CREATE INDEX IF NOT EXISTS "activities_team_start_submitted_idx"
  ON "activities" ("team_id", "start_datetime")
  WHERE "status" = 'submitted' AND "is_archived" = false;

CREATE INDEX IF NOT EXISTS "activities_team_created_submitted_idx"
  ON "activities" ("team_id", "created_at")
  WHERE "status" = 'submitted' AND "is_archived" = false;

CREATE INDEX IF NOT EXISTS "activities_user_start_idx"
  ON "activities" ("user_id", "start_datetime")
  WHERE "is_archived" = false;

CREATE INDEX IF NOT EXISTS "activities_user_outlook_idx"
  ON "activities" ("user_id", "outlook_event_id");

CREATE INDEX IF NOT EXISTS "activities_what_idx"
  ON "activities" ("sf_what_type", "sf_what_id")
  WHERE "sf_what_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "activities_team_related_idx"
  ON "activities" ("team_id", "sf_related_id")
  WHERE "sf_related_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "activities_account_idx"
  ON "activities" ("sf_account_id")
  WHERE "sf_account_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "activities_who_idx"
  ON "activities" ("sf_who_type", "sf_who_id")
  WHERE "sf_who_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "team_members_user_idx"
  ON "team_members" ("user_id");
