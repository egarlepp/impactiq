-- v1.410.0: a HubSpot meeting ImpactIQ found already logged (by HubSpot's
-- own Outlook / Google calendar sync) and linked to the activity instead of
-- creating a second one. Such a meeting is filled in, never overwritten or
-- deleted by ImpactIQ.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "crm_record_adopted" boolean NOT NULL DEFAULT false;
