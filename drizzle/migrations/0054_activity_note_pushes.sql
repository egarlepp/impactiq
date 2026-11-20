-- Audit log of ImpactIQ notes pushed into Salesforce as ContentNote
-- records. Kept distinct from activity_notes so edits to a note don't
-- clobber the "pushed at" record, and so we can track multiple pushes
-- (e.g. same note published to both an Opp and its Account).
CREATE TABLE IF NOT EXISTS activity_note_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_note_id uuid NOT NULL REFERENCES activity_notes(id) ON DELETE CASCADE,
  pushed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sf_target_type text NOT NULL,
  sf_target_id text NOT NULL,
  sf_target_name text,
  sf_content_note_id text,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX IF NOT EXISTS activity_note_pushes_note_idx ON activity_note_pushes(activity_note_id);
CREATE INDEX IF NOT EXISTS activity_note_pushes_status_idx ON activity_note_pushes(status);
