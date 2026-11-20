-- vNext: retire the brand-palette system_settings singleton as a
-- separate concept from a real, per-team-assignable Theme (CLAUDE.md §14 —
-- see the ThemingConfig.tsx / themes.ts / admin.ts changes in this same
-- release). Before this, the palette was the pre-multi-theme org-wide
-- fallback used whenever no app_themes row was marked Active — it rendered
-- in the admin UI as a card that looked exactly like a Theme (Apply / Set as
-- Default / Edit / Clone) but had no id, so it could never be assigned to a
-- team via TeamThemePicker. That produced the reported "3 things on the
-- Themes page, only 2 selectable in the per-team dropdown" confusion.
--
-- This is a one-time, idempotent backfill: if app_themes is completely
-- empty (either a genuinely fresh install, or an existing install that only
-- ever used the palette and never created a named Theme), promote whatever
-- is currently configured on the palette into a real, Active app_themes row
-- named "Default" -- falling back to the same HARD_DEFAULTS color set
-- ThemingConfig.tsx has always used as its own out-of-the-box starting
-- point when the palette system_settings rows don't exist yet either (a
-- truly untouched install). Any install that already has at least one real
-- Theme (including one an admin already cloned by hand)
-- is left completely untouched -- WHERE NOT EXISTS guards the whole insert.
INSERT INTO app_themes (
  name, colors, is_active, logo_light, logo_dark,
  email_top_bar_color, email_bottom_bar_color, email_footer_left_text, email_header_logo_variant
)
SELECT
  'Default',
  COALESCE(
    (SELECT value FROM system_settings WHERE key = 'brand_palette'),
    '{
      "primaryLight": "#2563EB", "primaryDark": "#3B82F6",
      "surfaceLight": "#FFFFFF", "surfaceDark": "#111827",
      "linkLight": "#2563EB", "linkDark": "#60A5FA",
      "pageBgLight": "#F9FAFB", "pageBgDark": "#030712",
      "borderLight": "#E5E7EB", "borderDark": "#374151",
      "headerLightFrom": "#FFFFFF", "headerLightTo": "#E8E6F8",
      "headerDarkFrom": "#1A1536", "headerDarkTo": "#1E3A6E",
      "sidebarBgLight": "#FFFFFF", "sidebarBgDark": "#111827",
      "sidebarBgLightFrom": "#FFFFFF", "sidebarBgLightTo": "#F1F5F9",
      "sidebarBgDarkFrom": "#111827", "sidebarBgDarkTo": "#1E293B",
      "sidebarHighlightLight": "#EEF2FF", "sidebarHighlightDark": "#1E3A6E",
      "sidebarTextLight": "#4B5563", "sidebarTextDark": "#D1D5DB",
      "sidebarActiveTextLight": "#5851DB", "sidebarActiveTextDark": "#93C5FD",
      "sidebarTextMutedLight": "#9CA3AF", "sidebarTextMutedDark": "#6B7280",
      "sidebarBorderLight": "#E5E7EB", "sidebarBorderDark": "#374151",
      "sidebarPillBgLight": "#F9FAFB", "sidebarPillBgDark": "#1F2937",
      "navHoverBgLight": "#F3F4F6", "navHoverBgDark": "#1F2937",
      "userPillNameLight": "#111827", "userPillNameDark": "#F3F4F6",
      "userPillSubtitleLight": "#6B7280", "userPillSubtitleDark": "#9CA3AF",
      "headerTextLight": "#111827", "headerTextDark": "#F3F4F6"
    }'::jsonb
  ),
  true,
  (SELECT value->>'logoLight' FROM system_settings WHERE key = 'brand_palette_logos'),
  (SELECT value->>'logoDark' FROM system_settings WHERE key = 'brand_palette_logos'),
  (SELECT value->>'topBarColor' FROM system_settings WHERE key = 'brand_palette_email'),
  (SELECT value->>'bottomBarColor' FROM system_settings WHERE key = 'brand_palette_email'),
  (SELECT value->>'footerLeftText' FROM system_settings WHERE key = 'brand_palette_email'),
  (SELECT value->>'headerLogoVariant' FROM system_settings WHERE key = 'brand_palette_email')
WHERE NOT EXISTS (SELECT 1 FROM app_themes);
