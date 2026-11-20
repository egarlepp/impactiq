-- v1.377.0: give the ten default Activity Types their default icon and icon
-- color on installs that existed before v1.376.0, so the Guide and Admin show
-- them without an admin clicking Seed Default Content. Fills blanks only, never
-- overwrites an admin's pick. Matches src/shared/defaultActivityTypeStyles.ts.
UPDATE team_activity_types AS t SET icon = d.icon
FROM (VALUES
  ('Demo', 'Presentation', '#4F46E5'),
  ('Discovery', 'Search', '#0EA5E9'),
  ('Enablement', 'GraduationCap', '#10B981'),
  ('Eval Work', 'FlaskConical', '#7C3AED'),
  ('Executive Briefing', 'Users', '#F59E0B'),
  ('HealthCheck', 'Activity', '#3730A3'),
  ('Marketing', 'Megaphone', '#DB2777'),
  ('Meeting', 'MessageSquare', '#4B5563'),
  ('RFx Work', 'FileText', '#F97316'),
  ('Support', 'LifeBuoy', '#DC2626')
) AS d(name, icon, color)
WHERE t.name = d.name AND (t.icon IS NULL OR btrim(t.icon) = '');
--> statement-breakpoint
UPDATE team_activity_types AS t SET color = d.color
FROM (VALUES
  ('Demo', 'Presentation', '#4F46E5'),
  ('Discovery', 'Search', '#0EA5E9'),
  ('Enablement', 'GraduationCap', '#10B981'),
  ('Eval Work', 'FlaskConical', '#7C3AED'),
  ('Executive Briefing', 'Users', '#F59E0B'),
  ('HealthCheck', 'Activity', '#3730A3'),
  ('Marketing', 'Megaphone', '#DB2777'),
  ('Meeting', 'MessageSquare', '#4B5563'),
  ('RFx Work', 'FileText', '#F97316'),
  ('Support', 'LifeBuoy', '#DC2626')
) AS d(name, icon, color)
WHERE t.name = d.name AND (t.color IS NULL OR btrim(t.color) = '');
