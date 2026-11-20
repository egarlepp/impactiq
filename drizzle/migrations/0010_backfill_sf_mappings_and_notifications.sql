-- Backfill new default SF field mappings for every existing team.
-- Idempotent: only inserts a row if (team_id, app_field) doesn't already exist.
INSERT INTO sf_field_mappings (team_id, app_field, sf_field_api, sf_object, is_active, updated_at)
SELECT t.id, m.app_field, m.sf_field_api, 'Event'::sf_object_type, true, now()
FROM teams t
CROSS JOIN (VALUES
  ('startdatetime',          'StartDateTime'),
  ('enddatetime',            'EndDateTime'),
  ('description',            'Description'),
  ('location',               'Location'),
  ('created_date__c',        'Created_Date__c'),
  ('assigned_to_name__c',    'Assigned_To_Name__c'),
  ('account_name__c',        'Account_Name__c'),
  ('account_owner',          'Account_Owner'),
  ('account_owner_manager',  'Account_Owner_Manager')
) AS m(app_field, sf_field_api)
WHERE NOT EXISTS (
  SELECT 1 FROM sf_field_mappings
  WHERE team_id = t.id AND app_field = m.app_field
);

-- And register them in the team-junction table the same way.
INSERT INTO sf_field_mapping_teams (sf_field_mapping_id, team_id)
SELECT m.id, m.team_id
FROM sf_field_mappings m
WHERE m.app_field IN (
  'startdatetime', 'enddatetime', 'description', 'location',
  'created_date__c', 'assigned_to_name__c', 'account_name__c',
  'account_owner', 'account_owner_manager'
)
AND NOT EXISTS (
  SELECT 1 FROM sf_field_mapping_teams
  WHERE sf_field_mapping_id = m.id AND team_id = m.team_id
);

-- Notification system: persistent in-app notifications (powers the bell icon + toast).
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  kind        text NOT NULL,                -- 'nudge' | 'system' | (future)
  message     text NOT NULL,
  link        text,                          -- optional in-app destination
  is_read     boolean NOT NULL DEFAULT false,
  dedupe_key  text,                          -- prevents duplicate spam from polling
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, is_read, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
