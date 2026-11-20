-- Audit trail of admin actions. Written by services/audit/log.ts and
-- surfaced on Admin → Audit Log. Not user-editable; append-only from the
-- app's perspective (no PATCH/DELETE routes wired). ON DELETE SET NULL on
-- actor_user_id so removing a user doesn't wipe their audit history.
CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email   text,
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  meta          jsonb,
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_at ON audit_events (created_at DESC);
CREATE INDEX audit_events_actor ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_action ON audit_events (action, created_at DESC);
