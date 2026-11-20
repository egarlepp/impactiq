-- How many items one AI request covered (v1.473.0). Calendar activity type
-- suggestions now send all of a person's unmatched meetings in one request,
-- and Usage this month shows how many it ran against. Null = one item (every
-- request logged before this, and every feature that sends one thing).
ALTER TABLE ai_requests ADD COLUMN IF NOT EXISTS item_count integer;
