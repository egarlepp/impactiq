-- v1.190.0: daily point-in-time history of the open-pipeline attach rate per
-- team, so the Attach Rate dashboard's Open Pipeline basis can show
-- week-over-week Compare and a weekly trend. Overall per team; one row per
-- team per day. Populated by the refresh_opp_coverage job.
CREATE TABLE IF NOT EXISTS "attach_rate_history" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "snapshot_date" date NOT NULL,
  "total" integer DEFAULT 0 NOT NULL,
  "attached" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("team_id", "snapshot_date")
);
