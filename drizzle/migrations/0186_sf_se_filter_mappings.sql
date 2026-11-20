-- v1.474.0: the Salesforce "my Opportunities" search and the Assigned SE
-- picker no longer hardcode custom fields (Assigned_SE__c and friends). They
-- read CRM Field Mappings instead: opp_se_filter (Opportunity fields that name
-- the people on a deal, several rows allowed) and assigned_se_write (the
-- picker's field). With nothing mapped, the search matches the Opportunity
-- owner and the picker is hidden, which works on any Salesforce org.
--
-- An install already using Salesforce relied on the old hardcoded fields, so
-- this maps exactly those fields for every team that has no mapping of that
-- kind yet, keeping its behavior. "Already using Salesforce" = some user has
-- connected Salesforce and the install's CRM isn't set to HubSpot or None.
-- Fresh installs have no teams when migrations run, so nothing is added there.

WITH sf_install AS (
  SELECT 1 AS ok
  WHERE EXISTS (SELECT 1 FROM user_integrations WHERE provider = 'salesforce')
    AND NOT EXISTS (
      SELECT 1 FROM system_settings
      WHERE key = 'crm_provider' AND value->>'provider' IN ('hubspot', 'none')
    )
),
filter_targets AS (
  SELECT t.id AS team_id, f.api
  FROM teams t
  CROSS JOIN sf_install
  CROSS JOIN (VALUES ('Assigned_SE__c'), ('Primary_Engineer__c'), ('Specialist_Engineer__c'), ('Supporting_Engineers__c')) AS f(api)
  WHERE NOT EXISTS (
    SELECT 1 FROM crm_field_mappings m
    JOIN crm_field_mapping_teams mt ON mt.crm_field_mapping_id = m.id
    WHERE mt.team_id = t.id AND m.app_field = 'opp_se_filter'
  )
),
write_targets AS (
  SELECT t.id AS team_id, 'Assigned_SE__c' AS api
  FROM teams t
  CROSS JOIN sf_install
  WHERE NOT EXISTS (
    SELECT 1 FROM crm_field_mappings m
    JOIN crm_field_mapping_teams mt ON mt.crm_field_mapping_id = m.id
    WHERE mt.team_id = t.id AND m.app_field = 'assigned_se_write'
  )
),
inserted AS (
  INSERT INTO crm_field_mappings (team_id, app_field, crm_field_api, crm_object, is_active, direction)
  SELECT team_id, 'opp_se_filter', api, 'Opportunity', true, 'read' FROM filter_targets
  UNION ALL
  SELECT team_id, 'assigned_se_write', api, 'Opportunity', true, 'read_write' FROM write_targets
  RETURNING id, team_id
)
INSERT INTO crm_field_mapping_teams (crm_field_mapping_id, team_id)
SELECT id, team_id FROM inserted;
