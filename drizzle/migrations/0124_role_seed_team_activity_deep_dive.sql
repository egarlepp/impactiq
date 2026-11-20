-- v1.245.0: seed role_permissions for the new Team Activity Deep-Dive
-- dashboard tab (Manager group). Without this row hasPermission() treats
-- the key as DENIED for every leader/team_admin whose team already has an
-- explicit permission matrix (see 0113_role_matrix_backfill.sql's note) —
-- the tab would render in the sidebar but be invisible to everyone who
-- isn't an App Admin. Follows the exact seeding convention 0113 used for
-- the sibling Manager-group dashboards (managerRollup, userLeaderboard).
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',     'dashboard.teamActivityDeepDive', true),
  ('team_admin', 'dashboard.teamActivityDeepDive', true)
ON CONFLICT (role, page_key) DO NOTHING;
