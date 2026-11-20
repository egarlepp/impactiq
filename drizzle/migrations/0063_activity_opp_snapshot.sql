-- Snapshot fields captured at the time an activity is linked to a
-- Salesforce Opportunity. Frozen when the user picks the Opp so
-- historical reporting reflects the state at meeting time, not now.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS sales_stage text,
  ADD COLUMN IF NOT EXISTS forecast_category text,
  ADD COLUMN IF NOT EXISTS opp_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS opp_close_date date;
