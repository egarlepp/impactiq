-- v1.193.0: store Opportunity Name on the coverage snapshot so the Attach
-- Rate "no Assigned SE" call-out can list the opportunities that are
-- attached only via secondary signals (activities / evaluation fields).
ALTER TABLE "sf_opportunity_coverage" ADD COLUMN IF NOT EXISTS "opp_name" text;
