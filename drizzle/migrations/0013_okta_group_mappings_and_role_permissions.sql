-- Okta group → ImpactIQ role mapping (for auto-provisioning).
-- When the admin policy allows JIT and the Okta userinfo returns a 'groups'
-- claim, the callback picks the lowest sort_order mapping whose okta_group
-- matches any of the user's groups, and creates a team_members row using
-- the configured role + team. Falls back to defaults if no match.
CREATE TABLE IF NOT EXISTS okta_group_role_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  okta_group  text NOT NULL,
  role        role NOT NULL,
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Role → page access matrix for the Role Management admin page.
-- Admin role is treated as full-access at the application layer and is
-- never persisted here; everything else (contributor, leader, team_admin)
-- defaults to seeded values which the admin can then edit.
CREATE TABLE IF NOT EXISTS role_permissions (
  role        role NOT NULL,
  page_key    text NOT NULL,
  has_access  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role, page_key)
);

-- Default seeds. The page_key strings are the sidebar/admin route keys
-- referenced from the client RBAC helpers; keep them in sync.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'activities',           true),
  ('contributor', 'dashboard',            false),
  ('contributor', 'settings',             true),
  ('contributor', 'admin',                false),
  ('leader',      'activities',           true),
  ('leader',      'dashboard',            true),
  ('leader',      'settings',             true),
  ('leader',      'admin',                false),
  ('team_admin',  'activities',           true),
  ('team_admin',  'dashboard',            true),
  ('team_admin',  'settings',             true),
  ('team_admin',  'admin',                true),
  ('team_admin',  'admin.teams',          true),
  ('team_admin',  'admin.activity_types', true),
  ('team_admin',  'admin.keyword_rules',  true),
  ('team_admin',  'admin.nudge_rules',    true),
  ('team_admin',  'admin.sf_mappings',    false),
  ('team_admin',  'admin.integrations',   false),
  ('team_admin',  'admin.users',          true),
  ('team_admin',  'admin.capacity',       true),
  ('team_admin',  'admin.themes',         false),
  ('team_admin',  'admin.role_management', false)
ON CONFLICT (role, page_key) DO NOTHING;
