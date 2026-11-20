-- Team-level work-week defaults.
-- New users on a team pre-fill from these values in the admin create-user form.
-- The user's own row remains the source of truth once set.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS default_worker_type text NOT NULL DEFAULT 'full_time'
    CHECK (default_worker_type IN ('full_time','part_time','contractor')),
  ADD COLUMN IF NOT EXISTS default_work_days integer NOT NULL DEFAULT 31,
  ADD COLUMN IF NOT EXISTS default_work_day_start_hour integer NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS default_work_day_end_hour integer NOT NULL DEFAULT 18;
