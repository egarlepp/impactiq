-- Local mirror of Opportunity/Account → OwnerId + parent Account. Consumed
-- by the Sales Team Breakdown dashboard so demo IDs (demo-opp-*, demo-acc-*)
-- resolve without touching live Salesforce, and so a future background SF
-- sync can pre-warm this cache.
CREATE TABLE IF NOT EXISTS sf_object_owner_cache (
  sf_id text PRIMARY KEY,
  object_type text NOT NULL CHECK (object_type IN ('Opportunity','Account')),
  name text,
  account_id text,
  account_name text,
  owner_id text,
  owner_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sf_object_owner_cache_account_idx ON sf_object_owner_cache(account_id);
CREATE INDEX IF NOT EXISTS sf_object_owner_cache_owner_idx ON sf_object_owner_cache(owner_id);
