-- v1.440.0: outbound email delivery log for App Health (Email tile).
CREATE TABLE IF NOT EXISTS "email_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category" text NOT NULL,
  "recipient" text NOT NULL,
  "subject" text NOT NULL,
  "transport" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_deliveries_created_idx" ON "email_deliveries" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_deliveries_status_created_idx" ON "email_deliveries" ("status", "created_at");
