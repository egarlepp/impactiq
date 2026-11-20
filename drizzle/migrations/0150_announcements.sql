-- vNext: Announcements (Admin -> Workplace). Admin/Team Admin/Leader posts a
-- message targeted at a team, a subteam, or a specific user, shown in the
-- top-header banner and the notification bell. See CLAUDE.md §14 (Workplace
-- admin category) for the full write-up.

CREATE TYPE "announcement_target_type" AS ENUM ('team', 'subteam', 'user');

CREATE TABLE IF NOT EXISTS "announcements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "target_type" "announcement_target_type" NOT NULL,
  "subteam_id" uuid REFERENCES "subteams"("id") ON DELETE CASCADE,
  "target_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "message" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'info',
  "start_date" date NOT NULL,
  "end_date" date,
  "recurring_daily" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One row per (user, announcement) -- an UPSERT target, not an insert-many
-- table like nudge_dismissals. Whether a dismissal suppresses "today only"
-- or "forever" is entirely determined by announcements.recurring_daily at
-- READ time, not stored here -- see services/announcements/engine.ts.
CREATE TABLE IF NOT EXISTS "announcement_dismissals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "announcement_id" uuid NOT NULL REFERENCES "announcements"("id") ON DELETE CASCADE,
  "dismissed_at" timestamptz NOT NULL DEFAULT now(),
  "dismissed_local_date" text NOT NULL,
  UNIQUE ("user_id", "announcement_id")
);

-- Role Management matrix: without these rows, hasPermission() denies
-- admin.announcements for every team_admin/leader whose team already has an
-- explicit permission matrix populated (see 0013/0113's note on this) -- the
-- sidebar entry would render but the page itself would be invisible. App
-- Admins bypass the matrix entirely and need no row. Unlike Flight Deck
-- (0125, team_admin only -- a config-only page), this also seeds `leader`
-- since Leaders can post subteam/individual-targeted announcements.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('team_admin', 'admin.announcements', true),
  ('leader', 'admin.announcements', true)
ON CONFLICT (role, page_key) DO NOTHING;
