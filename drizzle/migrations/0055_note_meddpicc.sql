-- MEDDPICC tagging on notes. Each category is a list of text
-- snippets or free-form tag values; empty JSON object = untagged.
-- Kept on activity_notes rather than a join table so a single note
-- read carries its tags with zero extra queries.
ALTER TABLE activity_notes
  ADD COLUMN IF NOT EXISTS meddpicc jsonb NOT NULL DEFAULT '{}'::jsonb;
