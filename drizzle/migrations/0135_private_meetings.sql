-- v1.262.0: Private Meetings foundation (PRD §7 roadmap, Activities batch).
-- outlook_events.sensitivity caches Graph's own privacy marking
-- (normal/personal/private/confidential); activities.is_private_meeting is
-- a snapshot taken at approval time so the card can render the treatment
-- without a live Graph re-fetch; users.private_meetings_as_non_activity is
-- the new My Settings rule (default checked) that auto-marks a private
-- meeting Non-Activity, alongside the existing keyword-based rule.

ALTER TABLE outlook_events
  ADD COLUMN IF NOT EXISTS sensitivity text;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS is_private_meeting boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS private_meetings_as_non_activity boolean NOT NULL DEFAULT true;
