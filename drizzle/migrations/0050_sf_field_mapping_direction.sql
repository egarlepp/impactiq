-- Open sf_field_mappings up to any Salesforce object (not just Event/Task)
-- and add a per-mapping direction so admins can bind fields on Opportunity /
-- Account / custom objects for read-only display without exposing them to
-- the writeback pipeline. Also stores the reference target for lookup fields
-- (OwnerId → User) so future reads can traverse via SOQL.
ALTER TABLE sf_field_mappings ALTER COLUMN sf_object TYPE text;
ALTER TABLE sf_field_mappings
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'read_write';
ALTER TABLE sf_field_mappings
  ADD COLUMN IF NOT EXISTS reference_to text;
DO $$ BEGIN
  ALTER TABLE sf_field_mappings
    ADD CONSTRAINT sf_field_mappings_direction_chk
    CHECK (direction IN ('read', 'write', 'read_write'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
