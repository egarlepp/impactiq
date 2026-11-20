-- Activity type visual styling: color + icon shown on the activity card
-- background (light tint) and the Outlook calendar column when the event is
-- linked to an activity. Both nullable — existing rows get sensible defaults
-- backfilled below.
ALTER TABLE team_activity_types
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS icon text;

-- Backfill defaults for the seeded types.
UPDATE team_activity_types SET color = '#6366F1', icon = 'Presentation'   WHERE name = 'Demo'               AND color IS NULL;
UPDATE team_activity_types SET color = '#0EA5E9', icon = 'Search'         WHERE name = 'Discovery'          AND color IS NULL;
UPDATE team_activity_types SET color = '#10B981', icon = 'GraduationCap'  WHERE name = 'Enablement'         AND color IS NULL;
UPDATE team_activity_types SET color = '#8B5CF6', icon = 'FlaskConical'   WHERE name = 'Eval Work'          AND color IS NULL;
UPDATE team_activity_types SET color = '#F59E0B', icon = 'Users'          WHERE name = 'Executive Briefing' AND color IS NULL;
UPDATE team_activity_types SET color = '#14B8A6', icon = 'Activity'       WHERE name = 'HealthCheck'        AND color IS NULL;
UPDATE team_activity_types SET color = '#EC4899', icon = 'Megaphone'      WHERE name = 'Marketing'          AND color IS NULL;
UPDATE team_activity_types SET color = '#64748B', icon = 'MessageSquare'  WHERE name = 'Meeting'            AND color IS NULL;
UPDATE team_activity_types SET color = '#F97316', icon = 'FileText'       WHERE name = 'RFx Work'           AND color IS NULL;
UPDATE team_activity_types SET color = '#EF4444', icon = 'LifeBuoy'       WHERE name = 'Support'            AND color IS NULL;

-- Fallback for any other named types the admin created before this PR.
UPDATE team_activity_types SET color = '#64748B', icon = 'CircleDot' WHERE color IS NULL;

-- Per-user working-week / working-hours. work_days is a bitmask (Mon=1, Tue=2,
-- Wed=4, Thu=8, Fri=16, Sat=32, Sun=64). Default 31 = Mon-Fri.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS work_days integer NOT NULL DEFAULT 31,
  ADD COLUMN IF NOT EXISTS work_day_start_hour integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS work_day_end_hour integer NOT NULL DEFAULT 18;

ALTER TABLE users
  ADD CONSTRAINT users_work_days_range CHECK (work_days BETWEEN 0 AND 127),
  ADD CONSTRAINT users_work_day_start_range CHECK (work_day_start_hour BETWEEN 0 AND 23),
  ADD CONSTRAINT users_work_day_end_range CHECK (work_day_end_hour BETWEEN 1 AND 24 AND work_day_end_hour > work_day_start_hour);
