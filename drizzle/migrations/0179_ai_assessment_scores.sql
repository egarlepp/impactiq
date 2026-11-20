-- v1.462.0: AI Assessment scores. One row per activity and rubric, written
-- when AI Notes Generate read a Gong transcript or a Leader clicked Run
-- assessment. Each row keeps a snapshot of the rubric it was scored against
-- (name, version, criteria with weights) so a later rubric edit never
-- changes an old score. Shown to Leaders only, never to the activity owner.

CREATE TABLE IF NOT EXISTS "activity_ai_assessment_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  -- Null once the rubric is deleted; the snapshot below still reads.
  "assessment_id" uuid REFERENCES "ai_assessments"("id") ON DELETE SET NULL,
  "assessment_name" text NOT NULL,
  "assessment_version" integer NOT NULL,
  -- 0-100 with not-observed criteria counted as zero.
  "zeroed_score" integer NOT NULL,
  -- 0-100 over observed criteria only; null when nothing was observed.
  "observed_score" integer,
  "not_observed_count" integer NOT NULL,
  "criteria_count" integer NOT NULL,
  -- [{ criterionId, name, weight, level|null, rationale, citations }]
  "criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "gong_call_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "provider_id" uuid REFERENCES "ai_providers"("id") ON DELETE SET NULL,
  "model" text,
  "run_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "run_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "activity_ai_assessment_scores_uq" ON "activity_ai_assessment_scores" ("activity_id", "assessment_id");
CREATE INDEX IF NOT EXISTS "activity_ai_assessment_scores_team_idx" ON "activity_ai_assessment_scores" ("team_id", "run_at");

-- The Assessments tab on the activity drawer: Leaders and Team Admins by
-- default, never Contributors. The owner never sees their own scores.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'activities.ai_assessments', false),
  ('leader',      'activities.ai_assessments', true),
  ('team_admin',  'activities.ai_assessments', true)
ON CONFLICT (role, page_key) DO NOTHING;
