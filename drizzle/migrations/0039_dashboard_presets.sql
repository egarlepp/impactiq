-- Dashboard filter presets. Saved per user; scoped by uniqueness on (user, name).
CREATE TABLE IF NOT EXISTS dashboard_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS dashboard_presets_user_idx ON dashboard_presets(user_id);
