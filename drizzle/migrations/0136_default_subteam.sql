-- v1.263.0: self-service "default subteam" preference for the Scheduling
-- page's subteam filter (My Settings → Work & Notifications). See
-- drizzle/schema.ts for the full rationale.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_subteam_id uuid REFERENCES subteams(id) ON DELETE SET NULL;
