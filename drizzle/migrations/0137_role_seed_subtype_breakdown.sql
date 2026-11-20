-- v1.267.0: seed role_permissions for the new Activity SubType Breakdown
-- dashboard tab (Activity group). Without this row hasPermission() treats
-- the key as DENIED for every leader/team_admin — the tab would render in
-- the sidebar but be invisible to everyone who isn't an App Admin. Follows
-- the same seeding convention 0124 used for Team Activity Deep-Dive.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',     'dashboard.subtypeBreakdown', true),
  ('team_admin', 'dashboard.subtypeBreakdown', true)
ON CONFLICT (role, page_key) DO NOTHING;
