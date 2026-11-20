-- Add per-theme light/dark logo storage (base64 data URL, max ~2.7MB text)
-- and editable brand palette stored as a singleton system_settings row.

ALTER TABLE app_themes
  ADD COLUMN IF NOT EXISTS logo_light text,
  ADD COLUMN IF NOT EXISTS logo_dark  text;

CREATE TABLE IF NOT EXISTS system_settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
