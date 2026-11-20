-- Batch B of the nudge polish work (v1.63.0):
-- • `cooldown_hours` on nudge_rules — minimum interval before the same rule
--   fires for the same user again. NULL disables cooldown (fires every eval).
-- The engine consults nudge_events (already retained 30 days) to find the
-- last delivery and short-circuits if inside the window.
ALTER TABLE nudge_rules
  ADD COLUMN IF NOT EXISTS cooldown_hours integer;
