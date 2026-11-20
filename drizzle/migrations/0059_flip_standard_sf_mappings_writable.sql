-- Backfill: several standard-object SF field mappings shipped as
-- direction='read', which meant write-back silently dropped them (the
-- writeback filter only keeps write/read_write rows). That's why WhatId,
-- Description, Type, ActivityDateTime, EndDateTime, DurationInMinutes,
-- OwnerId, and Location weren't syncing to Salesforce even though the
-- rows appeared in SF Field Mappings.
--
-- This flips them to read_write so the mappings actually push. Custom
-- fields (ends with __c) are left alone — those are org-specific and
-- may intentionally be read-only pulls (ACV is the canonical example).
UPDATE sf_field_mappings
SET direction = 'read_write'
WHERE direction = 'read'
  AND sf_field_api IN (
    'WhatId',
    'WhoId',
    'Subject',
    'Type',
    'ActivityDateTime',
    'StartDateTime',
    'EndDateTime',
    'DurationInMinutes',
    'Description',
    'Location',
    'OwnerId',
    'ActivityDate'
  );
