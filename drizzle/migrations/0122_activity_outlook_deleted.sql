-- v1.242.0: track APPROVED activities whose Outlook event has been deleted
-- from the user's calendar, so they can be reviewed (Keep / Delete) instead of
-- silently pointing at a meeting that no longer exists.
--
-- Set only by the deletion-reconcile pass in syncUserCalendar, which runs only
-- after a SUCCESSFUL Graph fetch. A failed fetch must never look like a
-- deletion — a false positive here tells someone their real logged work
-- vanished, which is far worse than detecting it a sync later.
ALTER TABLE "activities" ADD COLUMN "outlook_deleted_at" timestamptz;

-- "Keep" was pressed: stays in ImpactIQ + Salesforce, and stops being
-- re-flagged by every later sync. Without this the review queue would
-- resurface the same activity forever, since the calendar event stays gone.
ALTER TABLE "activities" ADD COLUMN "outlook_deleted_kept" boolean NOT NULL DEFAULT false;

-- Partial index: every read of this is "the flagged, not-yet-kept ones for a
-- user", which is a tiny fraction of the table. A partial index keeps it
-- proportional to the queue rather than to activity history.
CREATE INDEX IF NOT EXISTS "activities_outlook_deleted_idx"
  ON "activities" ("user_id", "outlook_deleted_at")
  WHERE "outlook_deleted_at" IS NOT NULL AND "outlook_deleted_kept" = false;
