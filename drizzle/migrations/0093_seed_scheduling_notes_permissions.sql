-- v1.154.0: register the Scheduling and My Notes pages in the role-permission
-- matrix. Both nav links now gate on these page keys, so seed them granted for
-- every non-app-admin role (app admins are always full-access). Existing
-- deployments keep any admin-set value via ON CONFLICT DO NOTHING.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'scheduling', true),
  ('leader',      'scheduling', true),
  ('team_admin',  'scheduling', true),
  ('contributor', 'notes',      true),
  ('leader',      'notes',      true),
  ('team_admin',  'notes',      true)
ON CONFLICT (role, page_key) DO NOTHING;
