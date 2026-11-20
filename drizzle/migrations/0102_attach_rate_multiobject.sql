-- v1.189.0: Attach Rate fields can now live on a related object (e.g.
-- Evaluations__c) and be rolled up to the parent Opportunity. Two new
-- per-field settings:
--   resolve_users  — values are SF User Ids to resolve to names (true) vs
--                    already display names, e.g. a multi-select (false).
--   opp_link_field — for non-Opportunity objects, the lookup on that object
--                    back to Opportunity (defaults to Opportunity__c).
ALTER TABLE "attach_rate_fields" ADD COLUMN IF NOT EXISTS "resolve_users" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attach_rate_fields" ADD COLUMN IF NOT EXISTS "opp_link_field" text;
