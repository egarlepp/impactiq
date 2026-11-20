-- Per-activity-type override of the SF Type picklist value this row writes
-- to Salesforce. When NULL, writeback falls back to the activity type name
-- (previous behavior). When set, many ImpactIQ activity types (e.g. Build
-- out, Test, Architect) can all resolve to a single SF picklist value
-- (e.g. Eval Work). sf_event_type_config keeps its (team_id, sf_picklist_value)
-- keying so fallback + typical duration remain per-SF-value, not per-activity-type.
ALTER TABLE team_activity_types ADD COLUMN IF NOT EXISTS sf_picklist_value text;
