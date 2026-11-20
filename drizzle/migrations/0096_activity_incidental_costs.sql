-- v1.176.0: per-activity incidental/travel spend ("Direct Costs") for Remote
-- activities. Amounts are entered in the contributor's display currency
-- (incidental_currency) and FX-converted to USD on the cost dashboards.
ALTER TABLE "activities" ADD COLUMN "cost_transportation" numeric(14, 2);
ALTER TABLE "activities" ADD COLUMN "cost_lodging" numeric(14, 2);
ALTER TABLE "activities" ADD COLUMN "cost_food" numeric(14, 2);
ALTER TABLE "activities" ADD COLUMN "incidental_currency" text;
