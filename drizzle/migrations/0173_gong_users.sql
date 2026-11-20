-- v1.452.0 (Gong plan, phase 1): the Gong tenant's users, refreshed daily by
-- gong_user_sync and matched to ImpactIQ users by email.
CREATE TABLE IF NOT EXISTS "gong_users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text,
  "first_name" text,
  "last_name" text,
  "title" text,
  "active" boolean DEFAULT true NOT NULL,
  "last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "gong_users_email_lower_idx" ON "gong_users" (lower("email"));
