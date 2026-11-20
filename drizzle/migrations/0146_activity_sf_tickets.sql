-- v1.337.0: multi-valued Salesforce ticket attachment. Opt-in per Activity
-- Type via a 'ticket_picker' team_activity_type_sf_extras row (kind is
-- plain text, no schema change needed there). ImpactIQ-only storage — the
-- ticket number links out to Salesforce for viewing, never written back
-- (buildSfRecord() in writeback.ts never reads this table). One activity
-- can have many tickets, hence its own table with a denormalized per-row
-- snapshot (a live SF record has no local admin-managed row to join back
-- to, same reason sf_what_name/sf_related_name are stored directly on
-- activities).

CREATE TABLE "activity_sf_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "activity_id" uuid NOT NULL REFERENCES "activities"("id") ON DELETE CASCADE,
  "sf_ticket_id" text NOT NULL,
  "sf_ticket_number" text NOT NULL,
  "sf_subject" text,
  "sf_date_opened" timestamptz,
  "sf_status" text,
  "sf_contact" text,
  "sf_description" text,
  "sf_platform" text,
  "sf_owner" text,
  "attached_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "activity_sf_tickets_activity_id_sf_ticket_id_unique" UNIQUE("activity_id","sf_ticket_id")
);

CREATE INDEX "activity_sf_tickets_activity_id_idx" ON "activity_sf_tickets" ("activity_id");
