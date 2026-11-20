-- v1.138.0: SF field mappings gain a background-refresh flag + tracked job runs.
ALTER TABLE "sf_field_mappings" ADD COLUMN "background_refresh" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- v1.138.0: activity snapshot columns filled by refreshOppSnapshots.
ALTER TABLE "activities" ADD COLUMN "sf_primary_engineer_name" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_opp_owner_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_opp_owner_name" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_opp_close_date" date;--> statement-breakpoint


CREATE TABLE IF NOT EXISTS "job_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "job_key" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "duration_ms" integer,
  "status" text NOT NULL,
  "message" text,
  "detail" jsonb
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "job_runs_key_started_idx" ON "job_runs" ("job_key", "started_at" DESC);
