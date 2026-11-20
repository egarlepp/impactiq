-- Default Settings Profile (v1.471.0). A team's AI Note default sections
-- become a profile marked Default (at most one per team), so they are edited
-- in the same place as every other profile, can hold custom sections, and can
-- be swapped for another profile. combine_mode says what an assessment's
-- profile does to the default: 'add' its sections to it (the v1.466 behavior)
-- or 'replace' it. A person's own sections (My Settings) are never replaced.
ALTER TABLE ai_note_profiles ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
ALTER TABLE ai_note_profiles ADD COLUMN IF NOT EXISTS combine_mode text NOT NULL DEFAULT 'add';
DO $$ BEGIN
  ALTER TABLE ai_note_profiles ADD CONSTRAINT ai_note_profiles_combine_mode_check CHECK (combine_mode IN ('add', 'replace'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ai_note_profiles_one_default_idx ON ai_note_profiles (team_id) WHERE is_default;

-- Every team gets a Default profile holding the sections it used until now:
-- its saved default sections, else all built-in sections. teams.
-- ai_notes_default_sections is no longer read after this.
INSERT INTO ai_note_profiles (team_id, name, sections, custom_sections, is_default)
SELECT t.id,
       'Default',
       CASE
         WHEN t.ai_notes_default_sections IS NOT NULL AND cardinality(t.ai_notes_default_sections) > 0 THEN t.ai_notes_default_sections
         ELSE ARRAY['summary', 'checked', 'next_steps', 'risks', 'meddpicc']::text[]
       END,
       '[]'::jsonb,
       true
FROM teams t
WHERE NOT EXISTS (SELECT 1 FROM ai_note_profiles p WHERE p.team_id = t.id AND p.is_default);
