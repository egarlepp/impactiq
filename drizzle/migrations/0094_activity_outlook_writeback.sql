-- v1.156.0: write logged activities back to the user's own Outlook calendar
-- (per-user opt-in). Adds a status trio + the created Graph event id on
-- activities, and the opt-in flag on users. Deliberately does NOT reuse
-- outlook_event_id (that means "activity created FROM this inbound meeting").
CREATE TYPE "outlook_sync_status" AS ENUM ('pending', 'synced', 'failed');

ALTER TABLE "activities" ADD COLUMN "outlook_writeback_event_id" text;
ALTER TABLE "activities" ADD COLUMN "outlook_sync_status" "outlook_sync_status";
ALTER TABLE "activities" ADD COLUMN "outlook_sync_error" text;
ALTER TABLE "activities" ADD COLUMN "outlook_synced_at" timestamptz;

ALTER TABLE "users" ADD COLUMN "outlook_writeback_enabled" boolean NOT NULL DEFAULT false;
