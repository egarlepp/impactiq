-- v1.117.0: cache the parent Account of the suggested Opportunity
-- on outlook_events so approving a suggested card can stamp
-- sf_account_id / sf_account_name onto the created activity. Enables
-- the clickable Account link on ActivityCard and correct roll-up in
-- the Account/Opportunity burn dashboard.
ALTER TABLE outlook_events
  ADD COLUMN IF NOT EXISTS suggested_sf_opportunity_account_id text,
  ADD COLUMN IF NOT EXISTS suggested_sf_opportunity_account_name text;
