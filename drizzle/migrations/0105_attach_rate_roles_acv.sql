-- v1.192.0: SE Leadership KPI expansion for Attach Rate.
--  - attach_rate_fields.role_label: admin-editable label per field for the
--    per-role breakdown (e.g. 'Assigned SE', 'Primary Engineer').
--  - sf_opportunity_coverage.owner_id: Opportunity OwnerId, for the
--    Sales-Team-Alignment rep-owned breakdown.
--  - sf_opportunity_coverage.amount: Opportunity Amount, for the
--    ACV-weighted attach rate.
ALTER TABLE "attach_rate_fields" ADD COLUMN IF NOT EXISTS "role_label" text;--> statement-breakpoint
ALTER TABLE "sf_opportunity_coverage" ADD COLUMN IF NOT EXISTS "owner_id" text;--> statement-breakpoint
ALTER TABLE "sf_opportunity_coverage" ADD COLUMN IF NOT EXISTS "amount" numeric(18, 2);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opp_coverage_owner" ON "sf_opportunity_coverage" ("owner_id");
