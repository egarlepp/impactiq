-- v1.91.0: cache SF Account + Opportunity suggestions on outlook_events so
-- suggestion cards can render an actionable "Possible Match" chip without
-- hitting Salesforce on every /api/outlook/suggestions poll. See design
-- notes in src/server/services/outlook/sync.ts.
ALTER TABLE outlook_events
  ADD COLUMN IF NOT EXISTS suggested_sf_account_id text,
  ADD COLUMN IF NOT EXISTS suggested_sf_account_name text,
  ADD COLUMN IF NOT EXISTS suggested_sf_opportunity_id text,
  ADD COLUMN IF NOT EXISTS suggested_sf_opportunity_name text,
  ADD COLUMN IF NOT EXISTS sf_suggestion_computed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sf_suggestion_candidates jsonb,
  -- User's manual override (chip dropdown pick). Takes precedence over the
  -- computed suggestion when Approve fires.
  ADD COLUMN IF NOT EXISTS user_override_sf_what_id text,
  ADD COLUMN IF NOT EXISTS user_override_sf_what_type text,
  ADD COLUMN IF NOT EXISTS user_override_sf_what_name text;
