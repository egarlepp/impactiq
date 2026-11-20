-- v1.213.0: Historical Salesforce Event import (pre-ImpactIQ activity).
--
-- These tables hold Salesforce Event records that predate ImpactIQ, linked
-- best-effort to users / Opportunities / Accounts. Their hours are ESTIMATES
-- derived from SF scheduled meeting length, so they are never joined into
-- cost, capacity, or utilization. See the schema.ts comment block for the
-- full rationale on why they live outside `activities`.
--
-- Retention: sf_historical_events and sf_historical_import_runs are
-- deliberately EXEMPT from the 6h housekeeping sweep. These rows are the
-- historical record, and culling run rows would break the provenance chain
-- (sf_historical_events.import_run_id references them).

CREATE TABLE IF NOT EXISTS sf_historical_import_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text NOT NULL,
  triggered_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  kind               text NOT NULL,
  slice_from         timestamptz,
  slice_to           timestamptz,
  events_fetched     integer NOT NULL DEFAULT 0,
  events_inserted    integer NOT NULL DEFAULT 0,
  events_skipped     integer NOT NULL DEFAULT 0,
  opps_upserted      integer NOT NULL DEFAULT 0,
  accounts_upserted  integer NOT NULL DEFAULT 0,
  users_matched      integer NOT NULL DEFAULT 0,
  users_unmatched    integer NOT NULL DEFAULT 0,
  types_matched      integer NOT NULL DEFAULT 0,
  types_unmatched    integer NOT NULL DEFAULT 0,
  sf_api_calls       integer NOT NULL DEFAULT 0,
  duration_ms        integer,
  error              text,
  detail             jsonb
);

CREATE TABLE IF NOT EXISTS sf_historical_events (
  sf_event_id         text PRIMARY KEY,
  subject             text,
  sf_type             text,
  activity_date       date,
  start_datetime      timestamptz,
  end_datetime        timestamptz,
  duration_minutes    integer,
  is_all_day_event    boolean NOT NULL DEFAULT false,
  is_recurrence       boolean NOT NULL DEFAULT false,
  owner_sf_user_id    text,
  owner_sf_user_name  text,
  what_id             text,
  what_type           text,
  what_name           text,
  who_id              text,
  account_id          text,
  description         text,
  location            text,
  sf_created_date     timestamptz,
  sf_system_modstamp  timestamptz,
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id             uuid REFERENCES teams(id) ON DELETE SET NULL,
  activity_type_id    uuid REFERENCES team_activity_types(id) ON DELETE SET NULL,
  user_match_method   text,
  type_match_method   text,
  estimated_hours     numeric(6,2),
  import_run_id       uuid REFERENCES sf_historical_import_runs(id) ON DELETE SET NULL,
  imported_at         timestamptz NOT NULL DEFAULT now(),
  relinked_at         timestamptz
);

CREATE TABLE IF NOT EXISTS sf_historical_opportunities (
  opp_id            text PRIMARY KEY,
  opp_name          text,
  account_id        text,
  account_name      text,
  stage_name        text,
  forecast_category text,
  is_closed         boolean NOT NULL DEFAULT false,
  is_won            boolean NOT NULL DEFAULT false,
  amount            numeric(18,2),
  total_acv         numeric(18,2),
  close_date        date,
  created_date      date,
  owner_id          text,
  owner_name        text,
  refreshed_at      timestamptz NOT NULL DEFAULT now(),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  -- Set once when IsClosed first becomes true; never cleared. The refresh
  -- job selects WHERE frozen_at IS NULL, so a frozen row is never re-pulled.
  frozen_at         timestamptz
);

CREATE TABLE IF NOT EXISTS sf_historical_accounts (
  account_id  text PRIMARY KEY,
  name        text,
  owner_id    text,
  industry    text,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sf_historical_type_map (
  team_id          uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sf_type_value    text NOT NULL,
  activity_type_id uuid REFERENCES team_activity_types(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, sf_type_value)
);

CREATE TABLE IF NOT EXISTS sf_historical_backfill_state (
  key                   text PRIMARY KEY,
  cursor_before         timestamptz NOT NULL,
  floor_at              timestamptz NOT NULL,
  slice_days            integer NOT NULL DEFAULT 90,
  status                text NOT NULL DEFAULT 'idle',
  last_run_id           uuid REFERENCES sf_historical_import_runs(id) ON DELETE SET NULL,
  total_events_imported integer NOT NULL DEFAULT 0,
  total_slices_done     integer NOT NULL DEFAULT 0,
  last_error            text,
  started_at            timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Partial indexes live here rather than in schema.ts because Drizzle's index
-- builder can't express `WHERE ...`. Precedent: 0109_perf_indexes.
-- All date-ordered indexes use activity_date (a `date`) since every history
-- view groups by day/week/month.
CREATE INDEX IF NOT EXISTS idx_hist_events_account   ON sf_historical_events (account_id, activity_date DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hist_events_what      ON sf_historical_events (what_id, activity_date DESC)    WHERE what_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hist_events_user_date ON sf_historical_events (user_id, activity_date DESC)    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hist_events_team_date ON sf_historical_events (team_id, activity_date DESC)    WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hist_events_date      ON sf_historical_events (activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_hist_events_unmatched ON sf_historical_events (owner_sf_user_id)               WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_hist_events_type      ON sf_historical_events (activity_type_id, activity_date DESC) WHERE activity_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hist_events_run       ON sf_historical_events (import_run_id);

-- Makes the nightly refresh SELECT an index scan that shrinks as opps close.
CREATE INDEX IF NOT EXISTS idx_hist_opps_to_refresh  ON sf_historical_opportunities (refreshed_at) WHERE frozen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hist_opps_account     ON sf_historical_opportunities (account_id);

-- Register the new History dashboard and the My History page in the
-- role-permission matrix. Existing deployments keep any admin-set value.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',      'dashboard.historyOverview', true),
  ('team_admin',  'dashboard.historyOverview', true),
  ('contributor', 'my_history', true),
  ('leader',      'my_history', true),
  ('team_admin',  'my_history', true)
ON CONFLICT (role, page_key) DO NOTHING;
