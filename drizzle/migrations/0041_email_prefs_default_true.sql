-- Flip email digest + weekly recap defaults to true for newly-created rows.
-- Existing rows are untouched so we respect user choices already made.
ALTER TABLE user_notification_prefs ALTER COLUMN email_enabled SET DEFAULT true;
ALTER TABLE user_notification_prefs ALTER COLUMN weekly_recap_enabled SET DEFAULT true;
