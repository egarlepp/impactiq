-- Fully loaded hourly cost rate for SE time. Team-level default; per-user
-- override wins when set. Both nullable — dashboards fall back to $0 (cost
-- column renders as "—") when neither is configured.
ALTER TABLE teams ADD COLUMN hourly_cost_rate numeric(10,2);
ALTER TABLE users ADD COLUMN hourly_cost_rate numeric(10,2);
