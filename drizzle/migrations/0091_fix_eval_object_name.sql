-- v1.149.0: migration 0090 seeded the Evaluation field mappings with a
-- hardcoded sf_object = 'Evaluation__c', but the real SF object API name
-- is whatever the admin configured on the Project (related_object_picker)
-- extras row — e.g. 'Evaluations__c'. When that name differs, the Admin
-- → SF Field Mappings edit dropdown can't find the object, the nightly
-- refresh queries the wrong object, and the Project panel shows blanks.
--
-- Correct the seeded rows in place: derive the true object name from
-- team_activity_type_sf_extras.config->>'sobject' for each team's
-- related_object_picker. Prefer a picker whose sobject looks
-- Evaluation-ish, else the earliest-created one, so teams with multiple
-- pickers resolve deterministically.
WITH picker AS (
  SELECT
    tat.team_id AS team_id,
    (e.config->>'sobject') AS sobject,
    ROW_NUMBER() OVER (
      PARTITION BY tat.team_id
      ORDER BY (CASE WHEN (e.config->>'sobject') ILIKE '%eval%' THEN 0 ELSE 1 END), e.created_at
    ) AS rn
  FROM team_activity_type_sf_extras e
  JOIN team_activity_types tat ON tat.id = e.team_activity_type_id
  WHERE e.kind = 'related_object_picker'
    AND (e.config->>'sobject') IS NOT NULL
    AND (e.config->>'sobject') <> ''
    AND (e.config->>'sobject') <> 'Evaluation__c'
)
UPDATE sf_field_mappings m
SET sf_object = picker.sobject
FROM picker
WHERE picker.rn = 1
  AND m.team_id = picker.team_id
  AND m.sf_object = 'Evaluation__c'
  AND m.app_field IN ('eval_name', 'eval_status', 'eval_stage', 'eval_type', 'eval_start_date', 'eval_end_date');
