-- v1.406.0: the HubSpot teams each owner is on, copied from the owners list
-- by hubspot_owner_sync. Team Management links an ImpactIQ team to HubSpot
-- teams the way it links Salesforce User.Department values, and User
-- Management shows a linked owner's teams.
ALTER TABLE "hubspot_owners" ADD COLUMN IF NOT EXISTS "teams" jsonb NOT NULL DEFAULT '[]'::jsonb;
