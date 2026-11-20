-- v1.182.0: register the new Infrastructure → Project-Specific Costing dashboard
-- in the role-permission matrix. The tab gates on 'dashboard.projectCosting', so
-- seed it granted for leaders and team admins (app admins are always full-access).
-- Existing deployments keep any admin-set value via ON CONFLICT DO NOTHING.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',     'dashboard.projectCosting', true),
  ('team_admin', 'dashboard.projectCosting', true)
ON CONFLICT (role, page_key) DO NOTHING;
