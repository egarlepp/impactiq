-- v1.431.0: a person filter on event webhooks, and the anomaly.found scan log.
ALTER TABLE "event_webhooks" ADD COLUMN IF NOT EXISTS "user_ids" uuid[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_webhook_anomaly_scans" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "week_start" date NOT NULL,
  "findings" integer NOT NULL,
  "scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("team_id", "week_start")
);
