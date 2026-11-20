-- v1.125.0

-- Per-team typical duration used by the Estimated vs Logged dashboard.
-- Falls back to sf_event_type_config.typical_duration_minutes when unset.
ALTER TABLE team_activity_types
  ADD COLUMN IF NOT EXISTS typical_duration_minutes integer;

-- Per-locale translations for nudge rule messages. Admin can add one
-- row per language on top of the base nudge_rules.message_template
-- (which stays as the fallback). Server picks the row matching the
-- user's active locale; if missing, falls back to the base template.
CREATE TABLE IF NOT EXISTS nudge_rule_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nudge_rule_id uuid NOT NULL REFERENCES nudge_rules(id) ON DELETE CASCADE,
  locale text NOT NULL,
  message_template text NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (nudge_rule_id, locale)
);
