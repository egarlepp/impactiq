-- v1.188.0: local snapshot of Salesforce opportunities for the Attach Rate
-- dashboard. Lets the dashboard + Compare + trend series read from Postgres
-- instead of running a live SOQL query per view. Refilled on a schedule by
-- the refresh_opp_coverage job; one row per opportunity.
CREATE TABLE IF NOT EXISTS "sf_opportunity_coverage" (
  "opp_id" text PRIMARY KEY NOT NULL,
  "created_date" date,
  "close_date" date,
  "stage_name" text,
  "forecast_category" text,
  "is_closed" boolean DEFAULT false NOT NULL,
  "field_values" jsonb,
  "snapshot_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Indexes to keep the date-cohort + open-pipeline filters fast as the
-- snapshot grows.
CREATE INDEX IF NOT EXISTS "idx_opp_coverage_created" ON "sf_opportunity_coverage" ("created_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opp_coverage_close" ON "sf_opportunity_coverage" ("close_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opp_coverage_open" ON "sf_opportunity_coverage" ("is_closed");
