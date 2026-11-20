-- Notes as a first-class feature: a timestamped stream per activity,
-- rolled up to Opportunity and Account via activities.sf_what_*. The
-- legacy activities.notes column stays for back-compat during the
-- transition; every save appends here too so the timeline preserves
-- history instead of overwriting.
CREATE TABLE IF NOT EXISTS activity_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_notes_activity_idx ON activity_notes(activity_id);
CREATE INDEX IF NOT EXISTS activity_notes_created_at_idx ON activity_notes(created_at);

-- Seed one entry per activity that already has legacy notes so the
-- timeline isn't empty when the feature ships. Attributed to the
-- activity's owner + stamped with the activity's created_at.
INSERT INTO activity_notes (activity_id, body, created_by, created_at)
SELECT id, notes, user_id, created_at
FROM activities
WHERE notes IS NOT NULL AND length(trim(notes)) > 0;
