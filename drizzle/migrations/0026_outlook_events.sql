-- Persist every user's Outlook calendar events (past + configurable forward window).
-- The activity log links to these via activities.outlook_event_id (still just a text
-- FK-by-value — no cross-table FK, since the event may be pruned after retention).
CREATE TABLE outlook_events (
  id                text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject           text,
  body_preview      text,
  is_all_day        boolean NOT NULL DEFAULT false,
  start_datetime    timestamptz NOT NULL,
  end_datetime      timestamptz NOT NULL,
  location          text,
  organizer_name    text,
  organizer_email   text,
  attendees         jsonb,
  series_master_id  text,
  event_type        text,
  fetched_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outlook_events_user_range ON outlook_events (user_id, start_datetime);
CREATE INDEX outlook_events_master ON outlook_events (series_master_id);

ALTER TABLE users ADD COLUMN outlook_events_last_synced_at timestamptz;
