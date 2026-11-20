-- v1.261.0: Admin -> CRM Sync -> Issues -> Resolve. A manual "I've handled
-- this" annotation layered on top of a failed sync, not a status flip on
-- the underlying activity/note-push row — so a resolution can never mask
-- a genuinely new failure. See schema.ts for the full write-up of
-- issue_key and the "resolved_at >= the issue's own failure timestamp"
-- query-time freshness check.

CREATE TABLE "sync_issue_resolutions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source" text NOT NULL,
  "issue_key" text NOT NULL,
  "resolved_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
