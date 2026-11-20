-- v1.259.0: generalize activity_sync_audit from an activity-writeback-only
-- log into the tenant-wide "every Salesforce write attempt" trail behind
-- Admin -> CRM Sync -> History. Previously only the activity Event/Task
-- writeback worker logged here; note pushes (ContentNote), the Engineer
-- Notes / Situation-Next Steps prepend-update, Assigned SE writes, and the
-- other ad-hoc Opportunity/Evaluation field writes in salesforce.ts never
-- did, so an admin investigating a failure (e.g. "Push failed" on a note)
-- had nowhere to look. `source` DEFAULT 'activity_writeback' means every
-- existing row is correctly attributed with no backfill needed. activity_id
-- is now nullable because not every write traces back to one specific
-- activity row (an Evaluation record can be touched by several activities,
-- and a note push targets an Opportunity/Account directly).

ALTER TABLE activity_sync_audit
  ALTER COLUMN activity_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'activity_writeback',
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
