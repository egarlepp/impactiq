-- v1.227.0: Admin → Scheduling becomes editable (CLAUDE.md §14).
--
-- 'enabled' — per-job kill switch, read by src/server/services/jobs/scheduler.ts
-- before every tick. Defaults true so a fresh install with no admin changes
-- behaves exactly like every job did before this migration.
--
-- 'interval_ms' — per-job cadence override, nullable. NULL means "use the
-- job's hardcoded default interval". Only honored for jobs the Scheduling
-- page marks cadence-editable; ignored for the two time-of-day-gated jobs
-- and the manually-triggered historical backfill.
ALTER TABLE job_config ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE job_config ADD COLUMN interval_ms integer;
