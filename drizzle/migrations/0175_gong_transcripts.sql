-- v1.453.0 (Gong plan, phase 2): the Gong call index, activity links, the
-- transcript cache, the per-team leader switch and a manual Gong user link.
CREATE TABLE IF NOT EXISTS "gong_calls" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text,
  "title" text,
  "url" text,
  "scheduled_at" timestamp with time zone,
  "started_at" timestamp with time zone NOT NULL,
  "duration_s" integer,
  "scope" text,
  "is_private" boolean DEFAULT false NOT NULL,
  "calendar_event_id" text,
  "primary_user_id" text,
  "parties" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "party_emails" text[] DEFAULT '{}'::text[] NOT NULL,
  "party_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "crm_objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "crm_object_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gong_calls_started_at_idx" ON "gong_calls" ("started_at");
CREATE INDEX IF NOT EXISTS "gong_calls_calendar_event_idx" ON "gong_calls" ("calendar_event_id");
CREATE INDEX IF NOT EXISTS "gong_calls_party_emails_idx" ON "gong_calls" USING gin ("party_emails");
CREATE INDEX IF NOT EXISTS "gong_calls_party_user_ids_idx" ON "gong_calls" USING gin ("party_user_ids");

CREATE TABLE IF NOT EXISTS "activity_gong_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "gong_call_id" text NOT NULL,
  "title" text,
  "url" text,
  "started_at" timestamp with time zone,
  "duration_s" integer,
  "link_method" text NOT NULL,
  "match_score" integer,
  "linked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "activity_gong_calls_activity_call_uq" UNIQUE ("activity_id", "gong_call_id")
);
CREATE INDEX IF NOT EXISTS "activity_gong_calls_call_idx" ON "activity_gong_calls" ("gong_call_id");

CREATE TABLE IF NOT EXISTS "gong_transcript_cache" (
  "gong_call_id" text PRIMARY KEY NOT NULL,
  "monologues" jsonb NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gong_transcript_cache_fetched_at_idx" ON "gong_transcript_cache" ("fetched_at");

ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "transcripts_leader_access" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gong_user_id" text;

-- The Transcripts tab is a Role Management page key; granted to every
-- non-app-admin role by default (App Admins always have it). The access rule
-- in canReadTranscript() still decides which transcripts a person can read.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'activities.transcripts', true),
  ('leader',      'activities.transcripts', true),
  ('team_admin',  'activities.transcripts', true)
ON CONFLICT (role, page_key) DO NOTHING;
