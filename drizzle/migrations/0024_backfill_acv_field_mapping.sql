-- Backfill the ACV → Total_Acv__c SF field mapping for every existing team.
-- New teams get this row from applyDefaultTeamConfig; teams that were seeded
-- before v1.6.0 never had it and won't render the ACV UI until it's present.
INSERT INTO sf_field_mappings (team_id, app_field, sf_field_api, sf_object, is_active)
SELECT
  t.id,
  'acv',
  'Total_Acv__c',
  'Event',
  true
FROM teams t
WHERE NOT EXISTS (
  SELECT 1 FROM sf_field_mappings m
  WHERE m.team_id = t.id AND m.app_field = 'acv'
);

-- Link every newly-inserted (and any legacy) acv mapping to its own team via
-- sf_field_mapping_teams so it shows up in the team-scoped GET endpoint.
INSERT INTO sf_field_mapping_teams (sf_field_mapping_id, team_id)
SELECT m.id, m.team_id
FROM sf_field_mappings m
WHERE m.app_field = 'acv'
  AND NOT EXISTS (
    SELECT 1 FROM sf_field_mapping_teams l
    WHERE l.sf_field_mapping_id = m.id AND l.team_id = m.team_id
  );
