-- Subteams — arbitrary sub-groupings inside a team (Region-based,
-- Type-based, or free-form). One team → many subteams. Users can be
-- members and/or leaders of many subteams.
CREATE TABLE IF NOT EXISTS subteams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

CREATE INDEX IF NOT EXISTS idx_subteams_team ON subteams (team_id);

-- Membership + leadership rolled into one junction. A user can hold
-- both roles on the same subteam via two rows (composite PK covers it).
CREATE TABLE IF NOT EXISTS subteam_users (
  subteam_id uuid NOT NULL REFERENCES subteams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('leader','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subteam_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_subteam_users_user ON subteam_users (user_id);

-- Team Manager — a single hierarchy pointer to a user. Nullable so
-- existing teams don't need a manager assigned before the migration
-- runs. SET NULL on delete so removing a user doesn't cascade-orphan
-- the team.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
