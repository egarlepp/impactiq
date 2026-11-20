-- v1.412.0: tables that hold data for any CRM were named sf_* back when
-- Salesforce was the only CRM. HubSpot fills the same tables, so they become
-- crm_*. Only renames, no data changes; indexes, constraints and foreign keys
-- follow the table (their own names are left as they are). Each rename runs
-- only while the old name exists and the new one doesn't, so a second run is
-- a no-op. Salesforce-only tables (sf_event_type_config, sf_user_names,
-- sf_object_owner_cache) keep their names, and columns inside these tables
-- are renamed in a later migration.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('activity_sf_tickets', 'activity_crm_tickets'),
    ('team_activity_type_sf_extras', 'team_activity_type_crm_extras'),
    ('sf_field_mappings', 'crm_field_mappings'),
    ('sf_field_mapping_teams', 'crm_field_mapping_teams'),
    ('sf_opportunity_coverage', 'crm_opportunity_coverage'),
    ('sf_historical_import_runs', 'crm_historical_import_runs'),
    ('sf_historical_events', 'crm_historical_events'),
    ('sf_historical_opportunities', 'crm_historical_opportunities'),
    ('sf_historical_accounts', 'crm_historical_accounts'),
    ('sf_historical_type_map', 'crm_historical_type_map'),
    ('sf_historical_exclusions', 'crm_historical_exclusions'),
    ('sf_historical_backfill_state', 'crm_historical_backfill_state'),
    ('sf_users', 'crm_users'),
    ('sf_user_alignments', 'crm_user_alignments'),
    ('sf_snapshot_state', 'crm_snapshot_state'),
    ('sf_lead_account_link', 'crm_lead_account_link')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass(format('public.%I', r.old_name)) IS NOT NULL
       AND to_regclass(format('public.%I', r.new_name)) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;
