-- Add Salesforce Who-lookup columns to activities so a contributor can link
-- a meeting to a Contact or a Lead instead of only Opportunity/Account.
-- WhatId on SF Event/Task accepts Opportunity/Account/custom objects; WhoId
-- accepts Contact/Lead. Keeping them as two separate columns mirrors SF's
-- data model instead of forcing all four into one polymorphic bucket.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS sf_who_id text,
  ADD COLUMN IF NOT EXISTS sf_who_type text,
  ADD COLUMN IF NOT EXISTS sf_who_name text;
DO $$ BEGIN
  ALTER TABLE activities
    ADD CONSTRAINT activities_sf_who_type_chk
    CHECK (sf_who_type IS NULL OR sf_who_type IN ('Contact', 'Lead'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
