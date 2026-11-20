-- Worker Type + Work-Week Approval Workflow.
-- Adds a `worker_type` column to `users` (full_time / part_time / contractor)
-- and introduces a queue of pending work-week change requests that admins
-- must approve before the change lands on the user record.

ALTER TABLE users
  ADD COLUMN worker_type text NOT NULL DEFAULT 'full_time';

ALTER TABLE users
  ADD CONSTRAINT users_worker_type_check
  CHECK (worker_type IN ('full_time', 'part_time', 'contractor'));

CREATE TABLE work_week_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  notes text
);

CREATE INDEX work_week_change_requests_status_created_idx
  ON work_week_change_requests(status, created_at DESC);
