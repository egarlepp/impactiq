ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "sf_sync_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "sf_next_retry_at" timestamptz;
