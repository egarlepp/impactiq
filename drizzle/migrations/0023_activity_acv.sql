-- ACV (Annual Contract Value) captured per activity when the activity links
-- to a Salesforce Opportunity. Nullable — only meaningful on Opportunity-
-- linked rows. The writeback pushes this to the Opportunity's Total_Acv__c
-- (or whatever the team's sf_field_mappings row for the 'acv' app field
-- points at).
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS acv numeric(14, 2);
