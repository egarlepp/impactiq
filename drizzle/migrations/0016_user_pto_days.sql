-- Per-user PTO days: a contributor can mark specific days as personal time
-- off from the Activities page. PTO days are excluded from that user's
-- weekly capacity math the same way as assigned holiday-calendar dates.
CREATE TABLE IF NOT EXISTS user_pto_days (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        date NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS user_pto_days_user_idx ON user_pto_days (user_id);
