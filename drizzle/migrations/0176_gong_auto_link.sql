-- v1.456.0 (Gong plan, phase 3): auto-linking and the Gong webhook.
-- An Unlink is remembered so auto-linking never puts the same call back on
-- the same activity; a manual link clears it.
CREATE TABLE IF NOT EXISTS "gong_link_dismissals" (
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "gong_call_id" text NOT NULL,
  "dismissed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gong_link_dismissals_pk" PRIMARY KEY ("activity_id", "gong_call_id")
);

-- Accepted Gong webhooks, keyed by a hash of the signed token, so a replay
-- is refused on every replica. Kept for a day (the longest token lifetime
-- the receiver accepts).
CREATE TABLE IF NOT EXISTS "gong_webhook_receipts" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
