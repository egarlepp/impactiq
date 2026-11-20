-- Meeting-detail columns on activities:
--   description_body — full body of the source calendar event (kept
--                       separate from `notes` so the app-owned Notes field
--                       never gets overwritten by the calendar event body)
--   location_mode    — 'remote' | 'onsite', defaulted to remote for legacy rows
--   meeting_owner    — organiser name/email (from Graph's `organizer`)
--   attendees        — jsonb array of {name, email} for non-organiser invitees
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS description_body text,
  ADD COLUMN IF NOT EXISTS location_mode text NOT NULL DEFAULT 'remote',
  ADD COLUMN IF NOT EXISTS meeting_owner text,
  ADD COLUMN IF NOT EXISTS attendees jsonb;

-- Constrain location_mode to the two allowed values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'activities_location_mode_chk'
  ) THEN
    ALTER TABLE activities
      ADD CONSTRAINT activities_location_mode_chk
      CHECK (location_mode IN ('remote', 'onsite'));
  END IF;
END $$;
