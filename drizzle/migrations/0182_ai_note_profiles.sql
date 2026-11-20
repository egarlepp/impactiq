-- AI Note profiles (v1.466.0): a named set of AI Note sections a team defines
-- (Admin → Activities & Rules → AI Assessments → Settings) and attaches to an
-- AI Assessment. When an assessment runs on an activity, its profile's
-- sections are added to the owner's own sections for that AI Note.
CREATE TABLE IF NOT EXISTS ai_note_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  icon text,
  icon_color text,
  -- Built-in section keys (summary, checked, next_steps, risks, meddpicc).
  sections text[] NOT NULL DEFAULT '{}',
  -- AiNoteCustomSection[]: [{ key: "c_…", name, instructions, icon, color }].
  custom_sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_note_profiles_team_idx ON ai_note_profiles (team_id);

ALTER TABLE ai_assessments ADD COLUMN IF NOT EXISTS ai_note_profile_id uuid REFERENCES ai_note_profiles(id) ON DELETE SET NULL;

-- A custom section's name, icon and color at the time the item was written,
-- so the item still renders after the profile changes or is deleted.
ALTER TABLE activity_ai_note_items ADD COLUMN IF NOT EXISTS section_meta jsonb;
