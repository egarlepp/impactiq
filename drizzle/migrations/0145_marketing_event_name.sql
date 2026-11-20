-- v1.334.0: optional free text captured only when the chosen activity type
-- is named "Marketing" (same name-matched convention as meeting_type_reason
-- on this same table). ImpactIQ-only — never part of the Salesforce
-- writeback payload.
ALTER TABLE activities
  ADD COLUMN marketing_event_name text;
