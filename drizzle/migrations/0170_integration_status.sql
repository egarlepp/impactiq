-- v1.444.0: App Health's Integrations tile. The last successful and failed
-- call per integration, recorded from real calls (no live probes), and the
-- last token refresh failure on a user's own Salesforce / Microsoft
-- connection (cleared when a refresh or a reconnect succeeds).
CREATE TABLE IF NOT EXISTS "integration_status" (
  "integration" text PRIMARY KEY NOT NULL,
  "last_success_at" timestamp with time zone,
  "last_failure_at" timestamp with time zone,
  "last_error" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_integrations" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "user_integrations" ADD COLUMN IF NOT EXISTS "last_error_at" timestamp with time zone;
