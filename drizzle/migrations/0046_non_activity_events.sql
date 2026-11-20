-- Per-user "not an activity" flag on Outlook events. Meetings a user marks
-- here disappear from the Activities list (when the Show Non-Activities
-- toggle is off) and render dark gray on the Outlook calendar column.
CREATE TABLE IF NOT EXISTS non_activity_events (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outlook_event_id text NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, outlook_event_id)
);
CREATE INDEX IF NOT EXISTS non_activity_events_user_idx ON non_activity_events(user_id);
