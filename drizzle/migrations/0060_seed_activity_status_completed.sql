-- Seed a global Activity_Status__c='Completed' constant mapping so every
-- synced Event/Task carries that value automatically. The write-back
-- service respects mappings with `constant_value` set — see
-- writeback.buildSfRecord's constants loop.
--
-- One mapping per SObject (Event, Task), linked to every existing team
-- via sf_field_mapping_teams. Idempotent: skipped if a matching
-- constant mapping already exists.
DO $$
DECLARE
  seed_team_id uuid;
  new_id uuid;
BEGIN
  SELECT id INTO seed_team_id FROM teams ORDER BY created_at LIMIT 1;
  IF seed_team_id IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM sf_field_mappings
    WHERE sf_field_api = 'Activity_Status__c'
      AND constant_value = 'Completed'
      AND sf_object = 'Event'
  ) THEN
    INSERT INTO sf_field_mappings
      (team_id, app_field, sf_field_api, sf_object, is_active, direction, constant_value)
    VALUES
      (seed_team_id, 'activity_status_completed', 'Activity_Status__c', 'Event', true, 'write', 'Completed')
    RETURNING id INTO new_id;

    INSERT INTO sf_field_mapping_teams (sf_field_mapping_id, team_id)
    SELECT new_id, id FROM teams
    ON CONFLICT DO NOTHING;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM sf_field_mappings
    WHERE sf_field_api = 'Activity_Status__c'
      AND constant_value = 'Completed'
      AND sf_object = 'Task'
  ) THEN
    INSERT INTO sf_field_mappings
      (team_id, app_field, sf_field_api, sf_object, is_active, direction, constant_value)
    VALUES
      (seed_team_id, 'activity_status_completed', 'Activity_Status__c', 'Task', true, 'write', 'Completed')
    RETURNING id INTO new_id;

    INSERT INTO sf_field_mapping_teams (sf_field_mapping_id, team_id)
    SELECT new_id, id FROM teams
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
