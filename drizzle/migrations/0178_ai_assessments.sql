-- v1.461.0: AI Assessments. A team defines scored rubrics (criteria with a
-- weight and 1-5 level anchors) and assigns them to Activity Types and
-- Subtypes on Admin → Activities & Rules → AI Assessments. AI Notes scores
-- the assigned rubrics when a Gong transcript was read; the scores are shown
-- to Leaders only.

CREATE TABLE IF NOT EXISTS "ai_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The team that created it. Real team assignment is ai_assessment_teams.
  "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "description" text,
  "is_active" boolean DEFAULT true NOT NULL,
  -- Locked: only an App Admin can change or delete it; teams use it as is.
  "is_locked" boolean DEFAULT false NOT NULL,
  -- Bumped on every change to the rubric, stored with each score.
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ai_assessment_teams" (
  "assessment_id" uuid NOT NULL REFERENCES "ai_assessments"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  CONSTRAINT "ai_assessment_teams_pk" PRIMARY KEY ("assessment_id", "team_id")
);
CREATE INDEX IF NOT EXISTS "ai_assessment_teams_team_idx" ON "ai_assessment_teams" ("team_id");

CREATE TABLE IF NOT EXISTS "ai_assessment_criteria" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_id" uuid NOT NULL REFERENCES "ai_assessments"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- What the AI should look for on the call.
  "look_for" text,
  "weight" integer DEFAULT 10 NOT NULL,
  -- {"1": "...", "3": "...", "5": "..."}: what each score level means.
  "anchors" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ai_assessment_criteria_assessment_idx" ON "ai_assessment_criteria" ("assessment_id");

-- Which rubric runs for which Activity Type (and optionally one Subtype) on
-- a team. subtype_id null = every Subtype of that type without its own row.
CREATE TABLE IF NOT EXISTS "ai_assessment_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "activity_type_id" uuid NOT NULL REFERENCES "team_activity_types"("id") ON DELETE CASCADE,
  "subtype_id" uuid REFERENCES "team_activity_type_subtypes"("id") ON DELETE CASCADE,
  "assessment_id" uuid NOT NULL REFERENCES "ai_assessments"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_assessment_assignments_uq"
  ON "ai_assessment_assignments" ("team_id", "activity_type_id", COALESCE("subtype_id", '00000000-0000-0000-0000-000000000000'::uuid), "assessment_id");
CREATE INDEX IF NOT EXISTS "ai_assessment_assignments_lookup_idx" ON "ai_assessment_assignments" ("team_id", "activity_type_id");
