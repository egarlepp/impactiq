-- v1.141.0: per-job admin config. Currently only carries notify_on_error
-- so admins can subscribe to daily digests when a background job fails.
CREATE TABLE IF NOT EXISTS "job_config" (
  "job_key" text PRIMARY KEY,
  "notify_on_error" boolean DEFAULT false NOT NULL,
  "last_error_email_at" timestamp with time zone
);
