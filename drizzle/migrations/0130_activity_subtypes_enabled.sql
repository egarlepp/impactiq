-- v1.256.0: promotes Subtypes (team_activity_type_subtypes, shipped
-- display-only in 0128) into a real selectable field on the Log Activity
-- form and Activity Templates. Adds:
--   - teams.subtypes_enabled — team-wide kill switch, off by default so a
--     team that hasn't configured any Subtypes doesn't grow an extra
--     dropdown on every activity type just because this shipped.
--   - activities.subtype_id / subtype_name — the contributor's pick,
--     ImpactIQ-only (never part of the Salesforce writeback payload).
--     subtype_name is a denormalized snapshot taken at selection time
--     (same convention as sf_what_name) so a later Subtype rename/delete
--     doesn't blank out what was actually logged; subtype_id uses
--     ON DELETE SET NULL for the same reason.
--   - activity_templates.subtype_id / subtype_name — pre-fills the picker
--     when a template is applied.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS subtypes_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS subtype_id uuid REFERENCES team_activity_type_subtypes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subtype_name text;

ALTER TABLE activity_templates
  ADD COLUMN IF NOT EXISTS subtype_id uuid REFERENCES team_activity_type_subtypes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subtype_name text;
