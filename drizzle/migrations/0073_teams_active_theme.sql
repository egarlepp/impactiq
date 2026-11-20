-- v1.88.0: per-team active theme. Users see their default team's theme
-- when they log in. app_themes.is_active remains as the org-wide fallback
-- so teams without an assigned theme still render valid branding.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS active_theme_id uuid REFERENCES app_themes(id) ON DELETE SET NULL;
