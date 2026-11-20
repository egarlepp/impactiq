-- Team-level holiday calendar assignments (a team can be assigned up to 3
-- calendars; user picks in My Settings take precedence per resolution logic).
CREATE TABLE IF NOT EXISTS team_holiday_calendars (
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  calendar_id  uuid NOT NULL REFERENCES holiday_calendars(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, calendar_id)
);

-- Per-weekday hour override for users who want different working hours per
-- weekday (e.g. Fri short-day). NULL leaves the day at the default
-- work_day_start_hour → work_day_end_hour range.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS work_hours_per_day jsonb;

-- Seed default dashboard.* permissions so existing deployments don't hide
-- every tab from the leader role on first load. Contributors + team_admins
-- start with none; the app-admin sees everything unconditionally.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader', 'dashboard.heatmap',        true),
  ('leader', 'dashboard.thisWeek',       true),
  ('leader', 'dashboard.capacityTrend',  true),
  ('leader', 'dashboard.breakdown',      true),
  ('leader', 'dashboard.mix',            true),
  ('leader', 'dashboard.planVsActual',   true),
  ('leader', 'dashboard.burn',           true),
  ('leader', 'dashboard.concentration',  true),
  ('leader', 'dashboard.compliance',     true),
  ('leader', 'dashboard.lag',            true),
  ('leader', 'dashboard.wow',            true),
  ('team_admin', 'dashboard.heatmap',        true),
  ('team_admin', 'dashboard.thisWeek',       true),
  ('team_admin', 'dashboard.capacityTrend',  true),
  ('team_admin', 'dashboard.breakdown',      true),
  ('team_admin', 'dashboard.mix',            true),
  ('team_admin', 'dashboard.planVsActual',   true),
  ('team_admin', 'dashboard.burn',           true),
  ('team_admin', 'dashboard.concentration',  true),
  ('team_admin', 'dashboard.compliance',     true),
  ('team_admin', 'dashboard.lag',            true),
  ('team_admin', 'dashboard.wow',            true)
ON CONFLICT (role, page_key) DO NOTHING;
