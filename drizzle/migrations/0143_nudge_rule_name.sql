-- v1.324.0: editable display name for a nudge rule, so rules that share a
-- triggerType (e.g. two different "no_activity_days" rules for different
-- teams/configs) can be told apart on the Nudge History page and in admin
-- logs. Backfilled from trigger_type (Title Case, underscores -> spaces) for
-- every existing rule; nullable during backfill, then locked NOT NULL.
ALTER TABLE nudge_rules
  ADD COLUMN name text;
--> statement-breakpoint

UPDATE nudge_rules
  SET name = initcap(replace(trigger_type::text, '_', ' '))
  WHERE name IS NULL;
--> statement-breakpoint

ALTER TABLE nudge_rules
  ALTER COLUMN name SET NOT NULL;
