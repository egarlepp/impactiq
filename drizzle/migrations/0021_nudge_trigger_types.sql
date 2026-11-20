-- New nudge trigger types powered by the engine:
--   weekly_hours_below_target — user under { pctThreshold }% of capacity by { checkDay }
--   sf_sync_failed            — >= { count } SF sync failures pending
--   opportunity_stale         — opps with no activity in { days } days (linked before)
--   product_gap               — no activity for { productId } in { days } days
ALTER TYPE nudge_trigger_type ADD VALUE IF NOT EXISTS 'weekly_hours_below_target';
ALTER TYPE nudge_trigger_type ADD VALUE IF NOT EXISTS 'sf_sync_failed';
ALTER TYPE nudge_trigger_type ADD VALUE IF NOT EXISTS 'opportunity_stale';
ALTER TYPE nudge_trigger_type ADD VALUE IF NOT EXISTS 'product_gap';
