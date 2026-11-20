-- v1.413.0: last of the three sf_* -> crm_* renames. Columns that hold data
-- for any CRM (on CRM-neutral tables) and the enum types become crm_*. Only
-- renames, no data changes; indexes and constraints follow the column. Each
-- rename runs only while the old name exists and the new one doesn't, so a
-- second run is a no-op. Salesforce-only tables (sf_event_type_config,
-- sf_user_names, sf_object_owner_cache) keep their sf_* columns. Enum VALUES
-- (e.g. the nudge trigger 'sf_sync_failed') are stored data and are unchanged.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('teams', 'sf_departments', 'crm_departments'),
    ('users', 'sf_user_id', 'crm_user_id'),
    ('outlook_events', 'suggested_sf_account_id', 'suggested_crm_account_id'),
    ('outlook_events', 'suggested_sf_account_name', 'suggested_crm_account_name'),
    ('outlook_events', 'suggested_sf_opportunity_id', 'suggested_crm_opportunity_id'),
    ('outlook_events', 'suggested_sf_opportunity_name', 'suggested_crm_opportunity_name'),
    ('outlook_events', 'suggested_sf_opportunity_account_id', 'suggested_crm_opportunity_account_id'),
    ('outlook_events', 'suggested_sf_opportunity_account_name', 'suggested_crm_opportunity_account_name'),
    ('outlook_events', 'sf_suggestion_computed_at', 'crm_suggestion_computed_at'),
    ('outlook_events', 'sf_suggestion_candidates', 'crm_suggestion_candidates'),
    ('outlook_events', 'user_override_sf_what_id', 'user_override_crm_what_id'),
    ('outlook_events', 'user_override_sf_what_type', 'user_override_crm_what_type'),
    ('outlook_events', 'user_override_sf_what_name', 'user_override_crm_what_name'),
    ('team_activity_types', 'sf_object_type', 'crm_object_type'),
    ('team_activity_types', 'sf_picklist_value', 'crm_picklist_value'),
    ('activity_crm_tickets', 'sf_ticket_id', 'crm_ticket_id'),
    ('activity_crm_tickets', 'sf_ticket_number', 'crm_ticket_number'),
    ('activity_crm_tickets', 'sf_subject', 'crm_subject'),
    ('activity_crm_tickets', 'sf_date_opened', 'crm_date_opened'),
    ('activity_crm_tickets', 'sf_status', 'crm_status'),
    ('activity_crm_tickets', 'sf_contact', 'crm_contact'),
    ('activity_crm_tickets', 'sf_description', 'crm_description'),
    ('activity_crm_tickets', 'sf_platform', 'crm_platform'),
    ('activity_crm_tickets', 'sf_owner', 'crm_owner'),
    ('activity_sync_audit', 'sf_object', 'crm_object'),
    ('crm_field_mappings', 'sf_field_api', 'crm_field_api'),
    ('crm_field_mappings', 'sf_object', 'crm_object'),
    ('attach_rate_fields', 'sf_object', 'crm_object'),
    ('crm_historical_import_runs', 'sf_api_calls', 'crm_api_calls'),
    ('crm_historical_events', 'sf_event_id', 'crm_event_id'),
    ('crm_historical_events', 'sf_type', 'crm_type'),
    ('crm_historical_events', 'owner_sf_user_id', 'owner_crm_user_id'),
    ('crm_historical_events', 'owner_sf_user_name', 'owner_crm_user_name'),
    ('crm_historical_events', 'created_by_sf_user_id', 'created_by_crm_user_id'),
    ('crm_historical_events', 'created_by_sf_user_name', 'created_by_crm_user_name'),
    ('crm_historical_events', 'sf_created_date', 'crm_created_date'),
    ('crm_historical_events', 'sf_system_modstamp', 'crm_system_modstamp'),
    ('crm_historical_type_map', 'sf_type_value', 'crm_type_value'),
    ('crm_historical_exclusions', 'sf_user_id', 'crm_user_id'),
    ('opp_review_dismissals', 'sf_opp_id', 'crm_opp_id'),
    ('opp_review_dismissals', 'sf_opp_name', 'crm_opp_name'),
    ('crm_field_mapping_teams', 'sf_field_mapping_id', 'crm_field_mapping_id'),
    ('crm_user_alignments', 'sf_user_id', 'crm_user_id'),
    ('activity_note_pushes', 'sf_target_type', 'crm_target_type'),
    ('activity_note_pushes', 'sf_target_id', 'crm_target_id'),
    ('activity_note_pushes', 'sf_target_name', 'crm_target_name'),
    ('activity_note_pushes', 'sf_content_note_id', 'crm_content_note_id')
  ) AS v(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
    ('sf_object_type', 'crm_object_type'),
    ('sf_sync_status', 'crm_sync_status'),
    ('sf_what_type', 'crm_what_type'),
    ('sf_alignment_role', 'crm_alignment_role')
  ) AS v(old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typname = r.new_name) THEN
      EXECUTE format('ALTER TYPE %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;
