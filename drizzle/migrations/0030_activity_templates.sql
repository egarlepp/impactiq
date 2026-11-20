-- Activity templates: per-user saved shells for common activities. The user
-- clicks "New from template" and gets a pre-filled activity form.
CREATE TABLE activity_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id               uuid REFERENCES teams(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  activity_type_id      uuid REFERENCES team_activity_types(id) ON DELETE SET NULL,
  title_template        text NOT NULL,
  notes_template        text,
  effort_hours_default  decimal(4,2),
  location_mode_default text,
  product_ids           jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_templates_user ON activity_templates (user_id);
