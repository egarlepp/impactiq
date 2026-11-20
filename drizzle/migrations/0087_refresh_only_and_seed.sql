-- v1.140.0: extend sf_field_mappings with refresh_only_for_reports and
-- seed default Opportunity refresh-only rows so admins can SEE which
-- fields the nightly SF snapshot refresher pulls.
ALTER TABLE "sf_field_mappings" ADD COLUMN "refresh_only_for_reports" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- For every team that already has any sf_field_mappings row, insert the
-- 10 refresh-only Opportunity fields that refreshOppSnapshots is already
-- pulling into activities snapshot columns. INSERT ON CONFLICT skipped
-- since app_field values are non-unique (no unique constraint), so we
-- guard against duplicates via NOT EXISTS.
INSERT INTO sf_field_mappings (team_id, app_field, sf_field_api, sf_object, is_active, direction, background_refresh, refresh_only_for_reports)
SELECT DISTINCT t.id, x.app_field, x.sf_field_api, 'Opportunity', true, 'read', true, true
FROM teams t
CROSS JOIN (
  VALUES
    ('sales_stage', 'StageName'),
    ('forecast_category', 'ForecastCategoryName'),
    ('opp_amount', 'Amount'),
    ('is_closed', 'IsClosed'),
    ('is_won', 'IsWon'),
    ('opp_close_date', 'CloseDate'),
    ('opp_owner_id', 'OwnerId'),
    ('opp_owner_name', 'Owner.Name'),
    ('assigned_se_name', 'Assigned_SE__r.Name'),
    ('primary_engineer_name', 'Primary_Engineer__r.Name'),
    ('evaluation_lookup', 'Evaluation__c')
) AS x(app_field, sf_field_api)
WHERE NOT EXISTS (
  SELECT 1 FROM sf_field_mappings m
  WHERE m.team_id = t.id AND m.sf_object = 'Opportunity' AND m.sf_field_api = x.sf_field_api
);--> statement-breakpoint

-- Attach every inserted row to its owning team via the junction table
-- (which the UI filters by).
INSERT INTO sf_field_mapping_teams (sf_field_mapping_id, team_id)
SELECT m.id, m.team_id FROM sf_field_mappings m
WHERE m.refresh_only_for_reports = true
  AND NOT EXISTS (
    SELECT 1 FROM sf_field_mapping_teams j
    WHERE j.sf_field_mapping_id = m.id AND j.team_id = m.team_id
  );
