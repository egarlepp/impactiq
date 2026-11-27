-- v1.481.0: an activity logged by another tool through POST /api/v1/activities/log
-- (an activities:log key, docs/activity-log-api.md) carries that tool's own id for
-- it, such as "demoiq:run:<id>". The unique index makes the call safe to retry:
-- the same id never creates a second activity. Null for everything logged in
-- ImpactIQ itself.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS activities_external_ref_uniq ON activities (external_ref) WHERE external_ref IS NOT NULL;
