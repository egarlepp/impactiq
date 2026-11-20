-- Extend Team → SF Department linkage from a single string to an
-- array of up to five. Existing single-value teams migrate into the
-- new array column; the old column is dropped after the copy.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS sf_departments text[] NOT NULL DEFAULT '{}'::text[];

UPDATE teams
SET sf_departments = ARRAY[sf_department]::text[]
WHERE sf_department IS NOT NULL AND cardinality(sf_departments) = 0;

ALTER TABLE teams DROP COLUMN IF EXISTS sf_department;
