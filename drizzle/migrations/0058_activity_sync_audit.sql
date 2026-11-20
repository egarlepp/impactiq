-- Per-attempt audit of Salesforce write-back for each activity. Every
-- create/update attempt writes one row. Retention is enforced on write:
-- rows older than 5 days for the same activity are deleted after each
-- insert so the table stays small without a scheduled job.
CREATE TABLE IF NOT EXISTS activity_sync_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  operation text NOT NULL,
  sf_object text,
  sf_record_id text,
  error_message text,
  payload jsonb
);

CREATE INDEX IF NOT EXISTS idx_activity_sync_audit_activity
  ON activity_sync_audit (activity_id, attempted_at DESC);
