-- Per-delivery log for nudge notifications. Every time we emit a nudge
-- into the notifications table for a user, we also insert one row here
-- so admins can audit "who saw what, when, and why" across the tenant.
-- 30-day retention enforced by a periodic cull.
CREATE TABLE IF NOT EXISTS nudge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  nudge_rule_id uuid REFERENCES nudge_rules(id) ON DELETE SET NULL,
  trigger_type text NOT NULL,
  message text NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  delivered_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nudge_events_delivered ON nudge_events (delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_nudge_events_user ON nudge_events (user_id, delivered_at DESC);
