-- v1.152.0: migration 0090 seeded the Evaluation date fields with guessed
-- SF API names. The real API names in the reference org (confirmed via the
-- SF Field Mappings field picker) are:
--   Start Date: Install_Date__c            (was seeded 'Install_date__c')
--   End Date:   License_Key_Expiration__c  (was seeded 'Eval_EndDate')
--
-- Only touch rows that still hold the OLD seeded value, so admins who
-- already corrected the mapping in the UI aren't clobbered. Matches
-- regardless of sf_object ('Evaluation__c' or 'Evaluations__c') since we
-- key on app_field + the stale value.
UPDATE sf_field_mappings
SET sf_field_api = 'Install_Date__c'
WHERE app_field = 'eval_start_date' AND sf_field_api = 'Install_date__c';--> statement-breakpoint

UPDATE sf_field_mappings
SET sf_field_api = 'License_Key_Expiration__c'
WHERE app_field = 'eval_end_date' AND sf_field_api = 'Eval_EndDate';
