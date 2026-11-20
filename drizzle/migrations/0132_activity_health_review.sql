-- v1.258.0: Admin → Monitoring → Activity Health — a triage queue for the
-- optional "Why Meeting?" text captured by activities.meeting_type_reason
-- (0131). Adds a 3-state review status (ignore | will_watch | addressed,
-- null = not yet reviewed) plus who reviewed it and when, and seeds the
-- Role Management matrix row for the new page (App Admin only by default,
-- same convention as the other Monitoring pages in 0113/0124 — team_admin
-- gets an explicit false row so the toggle is visible and grantable rather
-- than silently absent).

CREATE TYPE "meeting_reason_review_status" AS ENUM ('ignore', 'will_watch', 'addressed');

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS meeting_type_reason_status meeting_reason_review_status,
  ADD COLUMN IF NOT EXISTS meeting_type_reason_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS meeting_type_reason_reviewed_at timestamptz;

INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('team_admin', 'admin.activity_health', false)
ON CONFLICT (role, page_key) DO NOTHING;
