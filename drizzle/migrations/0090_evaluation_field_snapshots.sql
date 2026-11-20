-- v1.148.0: Evaluation (Project) field integration.
-- 1. New activity snapshot columns for Evaluation__c fields, refreshed
--    nightly by refreshOppSnapshots and updated live on edit via the new
--    PATCH /api/salesforce/evaluations/:id endpoint.
ALTER TABLE "activities" ADD COLUMN "sf_eval_status" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_eval_stage" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_eval_type" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_eval_start_date" date;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "sf_eval_end_date" date;--> statement-breakpoint

-- 2. Seed Evaluation__c field mappings for every existing team, mirroring
--    migration 0087's pattern. direction=read_write + background_refresh
--    (not refresh_only_for_reports, since these ARE user-editable through
--    the new Project panel — unlike the earlier Opportunity refresh-only
--    seed rows, which had no dedicated write UI).
INSERT INTO sf_field_mappings (team_id, app_field, sf_field_api, sf_object, is_active, direction, background_refresh, refresh_only_for_reports)
SELECT DISTINCT t.id, x.app_field, x.sf_field_api, 'Evaluation__c', true, 'read_write', true, false
FROM teams t
CROSS JOIN (
  VALUES
    ('eval_name', 'Name'),
    ('eval_status', 'Status__c'),
    ('eval_stage', 'POC_Stage__c'),
    ('eval_type', 'Evaluation_Type__c'),
    ('eval_start_date', 'Install_date__c'),
    ('eval_end_date', 'Eval_EndDate')
) AS x(app_field, sf_field_api)
WHERE NOT EXISTS (
  SELECT 1 FROM sf_field_mappings m
  WHERE m.team_id = t.id AND m.sf_object = 'Evaluation__c' AND m.sf_field_api = x.sf_field_api
);--> statement-breakpoint

INSERT INTO sf_field_mapping_teams (sf_field_mapping_id, team_id)
SELECT m.id, m.team_id FROM sf_field_mappings m
WHERE m.sf_object = 'Evaluation__c'
  AND NOT EXISTS (
    SELECT 1 FROM sf_field_mapping_teams j
    WHERE j.sf_field_mapping_id = m.id AND j.team_id = m.team_id
  );
