-- v1.457.0 (Gong plan, phase 4): AI Notes on the activity drawer.
-- An AI Note is written from the activity's linked Gong transcript(s) and
-- the owner's own notes, only when the owner clicks Generate. Items arrive as
-- to_review; Keep makes them permanent, Remove deletes them.

-- Per-team switch, monthly spend limit (USD, null = no team limit, inside
-- the app-wide AI budget) and default sections.
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "ai_notes_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "ai_notes_monthly_limit_usd" numeric(10, 2);
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "ai_notes_default_sections" text[];

-- A person's own section choice (null = the team's default).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_notes_sections" text[];

-- AI calls made for a team, so a team's spend can be summed.
ALTER TABLE "ai_requests" ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "ai_requests_team_created_idx" ON "ai_requests" ("team_id", "created_at");

CREATE TABLE IF NOT EXISTS "activity_ai_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "generated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "provider_id" uuid REFERENCES "ai_providers"("id") ON DELETE SET NULL,
  "model" text,
  "input_hash" text,
  "gong_call_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "note_count" integer DEFAULT 0 NOT NULL,
  "used_private_notes" boolean DEFAULT false NOT NULL,
  CONSTRAINT "activity_ai_notes_activity_uq" UNIQUE ("activity_id")
);

CREATE TABLE IF NOT EXISTS "activity_ai_note_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ai_note_id" uuid NOT NULL REFERENCES "activity_ai_notes"("id") ON DELETE CASCADE,
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "section" text NOT NULL,
  "text" text NOT NULL,
  "verdict" text,
  "owner_name" text,
  "meddpicc_key" text,
  "citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'to_review' NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "from_transcript" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "copied_note_id" uuid REFERENCES "activity_notes"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "activity_ai_note_items_activity_idx" ON "activity_ai_note_items" ("activity_id");
CREATE INDEX IF NOT EXISTS "activity_ai_note_items_review_idx" ON "activity_ai_note_items" ("status", "created_at");

-- The AI Notes tab is a Role Management page key, granted to every
-- non-app-admin role by default like the Transcripts tab. The team switch
-- and the read rule in services/aiNotes/access.ts still apply.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'activities.ai_notes', true),
  ('leader',      'activities.ai_notes', true),
  ('team_admin',  'activities.ai_notes', true),
  ('team_admin',  'admin.ai_notes', true)
ON CONFLICT (role, page_key) DO NOTHING;
