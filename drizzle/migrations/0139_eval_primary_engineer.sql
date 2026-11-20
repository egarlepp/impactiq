-- v1.285.0: Evaluation ("Project") Primary Engineer snapshot column, same
-- convention as sf_eval_status/stage/type/start_date/end_date above it —
-- refreshed nightly (refresh_opp_snapshots) and live by the Project preview
-- popover once a team maps the new eval_primary_engineer app field under
-- Admin > SF Field Mappings.

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS sf_eval_primary_engineer text;
