-- Store daily FX rates fetched from an external source (default: European
-- Central Bank). Every rate is quoted per 1 USD so downstream conversion
-- is a single multiplication:
--   value_in_currency_X = value_in_usd * rate_per_usd_for_X
-- Populated by an admin-triggered refresh via /api/admin/fx-rates/refresh.

CREATE TABLE IF NOT EXISTS fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency text NOT NULL,
  rate_per_usd numeric(20,8) NOT NULL,
  source text NOT NULL,
  as_of date NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT fx_rates_currency_as_of_unique UNIQUE (currency, as_of)
);
CREATE INDEX IF NOT EXISTS fx_rates_currency_idx ON fx_rates (currency, as_of DESC);
