-- AI Assessments get an icon and an icon color (v1.465.0), shown on the
-- Assessments and Assignments tabs. Both optional; null falls back to the
-- clipboard icon in the default text color.
ALTER TABLE ai_assessments ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE ai_assessments ADD COLUMN IF NOT EXISTS icon_color text;
