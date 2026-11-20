-- Unify capacity + cost onto a shared model:
--   * groups own a policy (target_hours or hourly_rate)
--   * capacity_group_teams / cost_group_teams attach groups to any number
--     of teams; each team belongs to at most one group per policy
--     (UNIQUE(team_id) is what keeps the resolver deterministic)
--   * capacity_user_overrides / cost_user_overrides carry dated
--     per-user + per-team overrides with a reason
-- The old capacity_group_members table and hourly_cost_rate columns on
-- teams/users are dropped outright — this is dev data, we cut over
-- cleanly rather than dual-writing.

-- 1. Drop the old membership + team-scoped group + cost fields.
DROP TABLE IF EXISTS capacity_group_members CASCADE;
ALTER TABLE capacity_groups DROP COLUMN IF EXISTS team_id;
ALTER TABLE capacity_groups ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL;

ALTER TABLE users DROP COLUMN IF EXISTS hourly_cost_rate;
ALTER TABLE teams DROP COLUMN IF EXISTS hourly_cost_rate;

-- 2. capacity_group_teams — many-to-many with UNIQUE(team_id).
CREATE TABLE IF NOT EXISTS capacity_group_teams (
  group_id uuid NOT NULL REFERENCES capacity_groups(id) ON DELETE CASCADE,
  team_id  uuid NOT NULL REFERENCES teams(id)           ON DELETE CASCADE,
  PRIMARY KEY (group_id, team_id),
  CONSTRAINT capacity_group_teams_team_id_unique UNIQUE (team_id)
);

-- 3. capacity_user_overrides — dated per-user override rows.
CREATE TABLE IF NOT EXISTS capacity_user_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_hours_per_week numeric(4,1) NOT NULL,
  reason text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS capacity_user_overrides_user_team_idx
  ON capacity_user_overrides (user_id, team_id, effective_from);

-- 4. cost_groups + attachments + overrides (mirror of capacity).
CREATE TABLE IF NOT EXISTS cost_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  hourly_cost_rate numeric(10,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  region text,
  role_type text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_group_teams (
  group_id uuid NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,
  team_id  uuid NOT NULL REFERENCES teams(id)       ON DELETE CASCADE,
  PRIMARY KEY (group_id, team_id),
  CONSTRAINT cost_group_teams_team_id_unique UNIQUE (team_id)
);

CREATE TABLE IF NOT EXISTS cost_user_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  hourly_cost_rate numeric(10,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  reason text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_user_overrides_user_team_idx
  ON cost_user_overrides (user_id, team_id, effective_from);
