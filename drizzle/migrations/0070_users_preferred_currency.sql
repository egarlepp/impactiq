-- v1.75.0: users pick a preferred display currency (My Settings). ACV,
-- ARR, and weekly-revenue pills convert from Salesforce USD via the
-- latest fx_rates row. NULL = show raw USD (unchanged behavior).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_currency text;
