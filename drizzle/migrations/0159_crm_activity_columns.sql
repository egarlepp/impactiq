-- v1.411.0: the activities columns that hold CRM data were named sf_* back
-- when Salesforce was the only CRM. HubSpot fills the same columns, so they
-- become crm_*. Only renames, no data changes; indexes and constraints follow
-- the column. Each rename runs only while the old name still exists, so a
-- second run is a no-op. The enum TYPES sf_what_type / sf_sync_status keep
-- their names for now.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('activities', 'sf_is_closed', 'crm_is_closed'),
    ('activities', 'sf_is_won', 'crm_is_won'),
    ('activities', 'sf_snapshot_refreshed_at', 'crm_snapshot_refreshed_at'),
    ('activities', 'sf_what_id', 'crm_what_id'),
    ('activities', 'sf_what_type', 'crm_what_type'),
    ('activities', 'sf_what_name', 'crm_what_name'),
    ('activities', 'sf_account_id', 'crm_account_id'),
    ('activities', 'sf_account_name', 'crm_account_name'),
    ('activities', 'sf_assigned_se_name', 'crm_assigned_se_name'),
    ('activities', 'sf_primary_engineer_name', 'crm_primary_engineer_name'),
    ('activities', 'sf_opp_owner_id', 'crm_opp_owner_id'),
    ('activities', 'sf_opp_owner_name', 'crm_opp_owner_name'),
    ('activities', 'sf_opp_close_date', 'crm_opp_close_date'),
    ('activities', 'sf_related_type', 'crm_related_type'),
    ('activities', 'sf_related_id', 'crm_related_id'),
    ('activities', 'sf_related_name', 'crm_related_name'),
    ('activities', 'sf_eval_status', 'crm_eval_status'),
    ('activities', 'sf_eval_stage', 'crm_eval_stage'),
    ('activities', 'sf_eval_type', 'crm_eval_type'),
    ('activities', 'sf_eval_start_date', 'crm_eval_start_date'),
    ('activities', 'sf_eval_end_date', 'crm_eval_end_date'),
    ('activities', 'sf_eval_primary_engineer', 'crm_eval_primary_engineer'),
    ('activities', 'sf_who_id', 'crm_who_id'),
    ('activities', 'sf_who_type', 'crm_who_type'),
    ('activities', 'sf_who_name', 'crm_who_name'),
    ('activities', 'sf_what_deleted', 'crm_what_deleted'),
    ('activities', 'sf_who_deleted', 'crm_who_deleted'),
    ('activities', 'sf_related_deleted', 'crm_related_deleted'),
    ('activities', 'sf_disconnect_checked_at', 'crm_disconnect_checked_at'),
    ('activities', 'sf_record_id', 'crm_record_id'),
    ('activities', 'sf_sync_status', 'crm_sync_status'),
    ('activities', 'sf_sync_error', 'crm_sync_error'),
    ('activities', 'sf_synced_at', 'crm_synced_at'),
    ('activities', 'sf_sync_attempts', 'crm_sync_attempts'),
    ('activities', 'sf_next_retry_at', 'crm_next_retry_at'),
    ('activity_sync_audit', 'sf_record_id', 'crm_record_id')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;
