-- v1.127.0

-- Split displayName into first_name / last_name for grouping (e.g.
-- All-users notes grouped by surname). displayName stays as the
-- canonical full-name column rendered everywhere else — the server
-- keeps it in sync as `first_name || ' ' || last_name` on every user
-- update.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

-- Best-effort backfill: split on the first space.
UPDATE users
   SET first_name = COALESCE(first_name, NULLIF(split_part(display_name, ' ', 1), '')),
       last_name  = COALESCE(
                      last_name,
                      NULLIF(regexp_replace(display_name, '^[^ ]*\s*', ''), '')
                    )
 WHERE first_name IS NULL OR last_name IS NULL;

-- Private note flag. Only the creator and App Admins can read a
-- private note; team peers and team admins never do. Default false
-- so existing notes stay shared.
ALTER TABLE activity_notes
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
