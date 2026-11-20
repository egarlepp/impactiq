-- v1.216.0: bring role_permissions in line with the pages that actually exist.
--
-- hasPermission() treats an absent key as DENIED (`perms[pageKey] === true`),
-- so any page whose key was never seeded is invisible to leaders and team
-- admins even though the Role Management matrix lists it. Seven dashboards and
-- most Admin sections were in that state — that's the "15/19 granted" and
-- "6/22 granted" an admin sees today with no way to tell a deliberate denial
-- from a missing row.
--
-- Every INSERT is ON CONFLICT DO NOTHING, so an admin who has already made a
-- deliberate choice keeps it.

-- ── Dashboards ───────────────────────────────────────────────────────────
-- Documented leader dashboards (CLAUDE.md §13) that were never seeded, so
-- leaders currently can't see them at all. Granted to leader + team_admin,
-- matching how every other dashboard was seeded.
--
-- Note 'dashboard.sales_team_breakdown': the Role Management tree previously
-- listed this as 'dashboard.salesTeamBreakdown', which matches no tab key in
-- Dashboard.tsx — a checkbox that could never grant anything. Fixed in the
-- same release.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',     'dashboard.mostExpensive',        true),
  ('team_admin', 'dashboard.mostExpensive',        true),
  ('leader',     'dashboard.productsBreakdown',    true),
  ('team_admin', 'dashboard.productsBreakdown',    true),
  ('leader',     'dashboard.oppRoi',               true),
  ('team_admin', 'dashboard.oppRoi',               true),
  ('leader',     'dashboard.costPerAcv',           true),
  ('team_admin', 'dashboard.costPerAcv',           true),
  ('leader',     'dashboard.managerRollup',        true),
  ('team_admin', 'dashboard.managerRollup',        true),
  ('leader',     'dashboard.sales_team_breakdown', true),
  ('team_admin', 'dashboard.sales_team_breakdown', true),
  ('leader',     'dashboard.userLeaderboard',      true),
  ('team_admin', 'dashboard.userLeaderboard',      true)
ON CONFLICT (role, page_key) DO NOTHING;

-- ── Admin sections a team admin should manage ────────────────────────────
-- Team-scoped, day-to-day configuration. Follows the split already
-- established by earlier migrations (activity_types / keyword_rules /
-- nudge_rules / capacity / teams / users are true for team_admin) and
-- CLAUDE.md §5, which gives Team Admin capacity AND cost groups.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('team_admin', 'admin.activities_import',  true),
  ('team_admin', 'admin.activity_templates', true),
  ('team_admin', 'admin.cost_groups',        true)
ON CONFLICT (role, page_key) DO NOTHING;

-- ── Admin sections that stay App Admin only ──────────────────────────────
-- Seeded explicitly as false rather than left absent. The runtime behaviour is
-- identical, but the row makes the denial a recorded decision an admin can see
-- and reverse, instead of a gap that looks like a bug. Global config (§14) and
-- every Monitoring page (App Admin only, §14) belong here.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('team_admin', 'admin.calendars',            false),
  ('team_admin', 'admin.products',             false),
  ('team_admin', 'admin.sales_team_alignment', false),
  ('team_admin', 'admin.email_communications', false),
  ('team_admin', 'admin.slack',                false),
  ('team_admin', 'admin.mcp_server',           false),
  ('team_admin', 'admin.historical_import',    false),
  ('team_admin', 'admin.db_health',            false),
  ('team_admin', 'admin.audit_log',            false),
  ('team_admin', 'admin.login_history',        false),
  ('team_admin', 'admin.crm_sync',             false),
  ('team_admin', 'admin.nudge_history',        false),
  ('team_admin', 'admin.scheduling',           false),
  ('team_admin', 'admin.demo_data',            false)
ON CONFLICT (role, page_key) DO NOTHING;

-- ── Sync Issues + Sync History → CRM Sync ────────────────────────────────
-- The two pages merged into one. Carry any grant on either old key over to the
-- new one so a deliberate grant isn't silently lost, then retire the old keys.
INSERT INTO role_permissions (role, page_key, has_access)
SELECT role, 'admin.crm_sync', bool_or(has_access)
  FROM role_permissions
 WHERE page_key IN ('admin.sync_issues', 'admin.sync_history')
 GROUP BY role
ON CONFLICT (role, page_key) DO NOTHING;

DELETE FROM role_permissions WHERE page_key IN ('admin.sync_issues', 'admin.sync_history');

-- Retire the key that never matched a real tab (see note above).
DELETE FROM role_permissions WHERE page_key = 'dashboard.salesTeamBreakdown';
