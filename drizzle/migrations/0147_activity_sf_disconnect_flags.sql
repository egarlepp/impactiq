-- v1.344.0: detect Salesforce records an activity links to (What/Who/
-- Related) that have since been deleted in Salesforce. Populated by the
-- nightly detect_disconnected_links job and by the activity drawer's own
-- live check (GET /api/salesforce/activity-link-status) -- both only ever
-- set a flag true on a SUCCESSFUL query that omits the requested id, never
-- on a failed/thrown check, and both clear it back to false if the record
-- is found again later (self-healing, same convention as the Deleted
-- Outlook Activities feature -- see CLAUDE.md §10/§21).
ALTER TABLE "activities" ADD COLUMN "sf_what_deleted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "activities" ADD COLUMN "sf_who_deleted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "activities" ADD COLUMN "sf_related_deleted" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "activities" ADD COLUMN "sf_disconnect_checked_at" timestamptz;
--> statement-breakpoint

CREATE INDEX "activities_sf_disconnect_flags_idx" ON "activities" ("team_id")
  WHERE "sf_what_deleted" OR "sf_who_deleted" OR "sf_related_deleted";
