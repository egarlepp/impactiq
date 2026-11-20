-- v1.389.0: the HubSpot portal's owners, copied by the daily
-- hubspot_owner_sync job (HubSpot plan, phase 2a; CLAUDE.md §9). ImpactIQ
-- users are matched to a HubSpot owner by email, so the lookup index is on
-- lower(email). Archived owners are kept, flagged, so a deactivated HubSpot
-- user still resolves for history.
CREATE TABLE "hubspot_owners" (
  "id" text PRIMARY KEY,
  "hubspot_user_id" text,
  "email" text,
  "first_name" text,
  "last_name" text,
  "archived" boolean NOT NULL DEFAULT false,
  "last_synced_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "hubspot_owners_email_idx" ON "hubspot_owners" (lower("email"));
