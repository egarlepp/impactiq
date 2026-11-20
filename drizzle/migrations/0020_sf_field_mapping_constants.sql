-- Constant/literal values for SF field mappings. When constant_value is
-- non-null, the writeback sets record[sf_field_api] = constant_value regardless
-- of the app_field. Used to force fields like Activity_Status__c = 'Completed'
-- or ShowAs = 'Busy' on every synced Event.
ALTER TABLE sf_field_mappings
  ADD COLUMN IF NOT EXISTS constant_value text;
