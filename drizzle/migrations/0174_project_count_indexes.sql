-- v1.454.0: CriteriaIQ's project activity counts (POST /api/v1/effort/project-counts)
-- and the effort API match Salesforce ids on their 15-char form,
-- left(crm_*_id, 15), which the plain indexes on these columns can't serve.
CREATE INDEX IF NOT EXISTS "activities_related15_idx"
  ON "activities" (left("crm_related_id", 15))
  WHERE "crm_related_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "activities_opp15_idx"
  ON "activities" (left("crm_what_id", 15))
  WHERE "crm_what_type" = 'Opportunity';
