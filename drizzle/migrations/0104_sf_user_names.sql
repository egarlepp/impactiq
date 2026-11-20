-- v1.191.0: cache of Salesforce User Id → Name, populated by the
-- refresh_opp_coverage job. Lets the Attach Rate per-SE breakdown resolve
-- engineer lookup fields (which store SF User Ids) to display names even
-- when the user isn't an ImpactIQ user.
CREATE TABLE IF NOT EXISTS "sf_user_names" (
  "sf_user_id" text PRIMARY KEY NOT NULL,
  "name" text,
  "refreshed_at" timestamptz DEFAULT now() NOT NULL
);
