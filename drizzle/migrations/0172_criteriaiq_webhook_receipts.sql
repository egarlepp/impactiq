-- v1.450.0: CriteriaIQ live refresh. One row per accepted signed webhook, so a
-- delivery replayed inside the five-minute window is refused on every
-- replica. Rows older than an hour are deleted as new deliveries arrive.
CREATE TABLE IF NOT EXISTS "criteriaiq_webhook_receipts" (
  "signature" text PRIMARY KEY,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "criteriaiq_webhook_receipts_received_at_idx" ON "criteriaiq_webhook_receipts" ("received_at");
