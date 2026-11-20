-- AI Assessment Scores dashboard (v1.463.0): Leaders and Team Admins by
-- default, never Contributors. The route also requires the
-- activities.ai_assessments grant and leaves out the caller's own activities.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'dashboard.aiAssessments', false),
  ('leader',      'dashboard.aiAssessments', true),
  ('team_admin',  'dashboard.aiAssessments', true)
ON CONFLICT (role, page_key) DO NOTHING;
