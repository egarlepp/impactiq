-- v1.137.0: SF Opp snapshot refresh + Lead→Account link cache + closed-won flags on activities.
ALTER TABLE "activities" ADD COLUMN "sf_is_closed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_is_won" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_snapshot_refreshed_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sf_snapshot_state" (
  "key" text PRIMARY KEY,
  "refreshed_at" timestamp with time zone NOT NULL,
  "last_error" text
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sf_lead_account_link" (
  "lead_id" text PRIMARY KEY,
  "account_id" text,
  "refreshed_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "snapshot_refresh_last_at" timestamp with time zone;
