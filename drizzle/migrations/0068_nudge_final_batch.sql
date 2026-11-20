-- Final batch of the nudge polish work (v1.65.0):
-- • `conditions` — optional JSONB describing an AND/OR combinator applied on
--   top of the base triggerType. Shape: {op:'AND'|'OR', clauses:[{triggerType,
--   config}]}. When null the rule fires purely on its own triggerType (the
--   pre-v1.65.0 behavior). When set, the base trigger must match AND the
--   clauses must satisfy the combinator.
-- • `leader_rollup_threshold` — when non-null, this rule is a LEADER rollup
--   nudge: it fires for a team leader whose direct reports have at least N
--   overdue nudges of the same base type combined. Ignored for non-leaders.
ALTER TABLE nudge_rules
  ADD COLUMN IF NOT EXISTS conditions jsonb,
  ADD COLUMN IF NOT EXISTS leader_rollup_threshold integer;
