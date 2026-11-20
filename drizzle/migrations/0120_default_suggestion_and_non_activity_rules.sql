-- v1.240.0: configurable default suggestion type + keyword-rule "mark as
-- Non-Activity" action.
--
-- Default suggestion: the Outlook suggestion fallback (no keyword match, no
-- AI classification) previously picked "the first row an unordered SELECT
-- happened to return" rather than anything actually configured — see
-- src/server/routes/outlook.ts's /suggestions handler. is_default_suggestion
-- lets a team pick which type that fallback uses; the route also falls back
-- to lowest sort_order when no type has this set, which is deterministic
-- (unlike the previous behavior) even before any admin touches the setting.
ALTER TABLE "team_activity_types" ADD COLUMN "is_default_suggestion" boolean NOT NULL DEFAULT false;

-- Keyword rule action: 'suggest_type' is the original (and only) behavior.
-- 'mark_non_activity' auto-flags a matching event as a Non-Activity instead
-- (see non_activity_events, CLAUDE.md §7) — for recurring meetings like
-- "1-on-1" or "internal sync" that are never worth logging and shouldn't need
-- a manual dismissal every single week.
CREATE TYPE "keyword_rule_action" AS ENUM ('suggest_type', 'mark_non_activity');
ALTER TABLE "keyword_rules" ADD COLUMN "action" "keyword_rule_action" NOT NULL DEFAULT 'suggest_type';

-- activity_type_id is meaningless for a mark_non_activity rule — that action
-- doesn't suggest a type. Nullability is enforced by the admin route
-- (required for suggest_type, forced null for mark_non_activity), not a DB
-- constraint, matching how similar per-row invariants are handled elsewhere
-- in this schema.
ALTER TABLE "keyword_rules" ALTER COLUMN "activity_type_id" DROP NOT NULL;
