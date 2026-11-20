-- Add per-user opt-in for the Friday weekly recap email.
ALTER TABLE user_notification_prefs
  ADD COLUMN IF NOT EXISTS weekly_recap_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS last_weekly_recap_at timestamptz;
