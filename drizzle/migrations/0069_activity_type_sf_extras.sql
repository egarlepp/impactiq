-- v1.67.0: per-activity-type Salesforce Extras — additional SF context
-- shown on the Activity form when a specific type is chosen. Two kinds:
--   • opp_field_display     — read the value of an SF field on the linked
--                             Opportunity (config: {apiName, fieldType})
--   • related_object_picker — list child records of an SF object under the
--                             linked Opp; SE picks one and its Id + Name is
--                             stored on the activity (config: {sobject,
--                             parentField, labelField})
CREATE TABLE IF NOT EXISTS team_activity_type_sf_extras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_activity_type_id uuid NOT NULL REFERENCES team_activity_types(id) ON DELETE CASCADE,
  kind text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_atse_type ON team_activity_type_sf_extras (team_activity_type_id);

-- Denormalized SF child link on the activity (e.g. an Evaluation record
-- selected from the picker). Kept separate from sf_what_id so an Eval
-- Work activity can point at BOTH its parent Opportunity (sf_what_id)
-- AND the specific Evaluation record it represents (sf_related_id).
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS sf_related_type text,
  ADD COLUMN IF NOT EXISTS sf_related_id text,
  ADD COLUMN IF NOT EXISTS sf_related_name text;
