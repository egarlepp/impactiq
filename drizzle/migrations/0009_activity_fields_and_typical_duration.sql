-- Activity additions: location field.
-- The existing `notes` column already serves as the description; the field is
-- exposed as "description" in the SF mapping but stays `notes` in the DB to
-- preserve historical data.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS location text;

-- SF Type Mapping: how long this picklist value typically takes (minutes).
-- Surfaced in the admin SF Type config UI as a general guideline.
ALTER TABLE sf_event_type_config
  ADD COLUMN IF NOT EXISTS typical_duration_minutes integer;
