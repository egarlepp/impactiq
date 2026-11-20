-- vNext: optional custom icon + light/dark icon colors for the Announcements
-- top-header banner (never the bell or the bottom toast — those keep the
-- plain severity icon). See CLAUDE.md §14c. All nullable; null = unchanged
-- current behavior (plain severity icon/color).

ALTER TABLE "announcements"
  ADD COLUMN "icon" text,
  ADD COLUMN "icon_color_light" text,
  ADD COLUMN "icon_color_dark" text;

-- Mirrored onto notifications so the shared bell/banner poll (which any
-- signed-in Contributor can call, unlike the leader/admin-gated announcement
-- CRUD list) carries the color pair too. icon already existed here
-- (v1.62.0, used by nudges); only the two color columns are new.
ALTER TABLE "notifications"
  ADD COLUMN "icon_color_light" text,
  ADD COLUMN "icon_color_dark" text;
