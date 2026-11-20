-- Track when we last re-pulled the user's timezone from Outlook mailbox
-- settings, so the calendar poll can re-check at most once per hour instead
-- of every call.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone_checked_at timestamptz;
