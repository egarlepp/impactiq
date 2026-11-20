-- v1.194.0: store Opportunity Owner Name on the coverage snapshot so the
-- "Missing Assigned SE" call-out can show the owner and a suggested SE.
ALTER TABLE "sf_opportunity_coverage" ADD COLUMN IF NOT EXISTS "owner_name" text;
