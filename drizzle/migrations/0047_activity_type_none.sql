-- Backfill a "None" activity type on every existing team so cards that render
-- a Non-Activity meeting have a real type row to hang a label off. Inactive
-- so it doesn't appear in the Log-Activity type picker; used purely as a
-- display anchor for the Non-Activity state.
INSERT INTO team_activity_types (team_id, name, sf_object_type, is_active, sort_order, color)
SELECT t.id, 'None', 'Event', false, 999, '#6B7280'
FROM teams t
WHERE NOT EXISTS (
  SELECT 1 FROM team_activity_types x
  WHERE x.team_id = t.id AND x.name = 'None'
);
