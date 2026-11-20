-- v1.268.0: seed role_permissions for the new "Won w/o POC" dashboard tab
-- (Manager group). Without this row hasPermission() treats the key as
-- DENIED for every leader/team_admin — the tab would render in the sidebar
-- but be invisible to everyone who isn't an App Admin. Follows the same
-- seeding convention 0124/0137 used for the other Manager-group dashboards.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',     'dashboard.wonWithoutPoc', true),
  ('team_admin', 'dashboard.wonWithoutPoc', true)
ON CONFLICT (role, page_key) DO NOTHING;
