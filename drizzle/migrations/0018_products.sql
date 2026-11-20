-- App-owned product catalog. No Salesforce alignment — products are surfaced
-- on the Log Activity form as a multi-select so contributors can flag which
-- product(s) an activity relates to.
CREATE TABLE IF NOT EXISTS products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  space         text,
  abbreviation  text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_teams (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, team_id)
);

CREATE TABLE IF NOT EXISTS activity_products (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, product_id)
);
CREATE INDEX IF NOT EXISTS activity_products_product_idx ON activity_products (product_id);
