-- v1.230.0: Admin-editable send time for the two clock-gated Scheduling
-- jobs (CLAUDE.md §14). NULL means "use the hardcoded default" (digest:
-- 08:00 local; weekly recap: Friday 17:00 local), matching the existing
-- interval_ms fallback contract. schedule_day_of_week is Sunday-indexed
-- (0=Sun…6=Sat), matching Date#getDay(), and is only consulted by
-- weekly_recap_worker — digest_worker ignores it.
ALTER TABLE job_config ADD COLUMN schedule_hour integer;
ALTER TABLE job_config ADD COLUMN schedule_minute integer;
ALTER TABLE job_config ADD COLUMN schedule_day_of_week integer;
