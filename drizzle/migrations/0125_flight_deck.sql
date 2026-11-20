-- v1.249.0: Flight Deck jumpstart checklist — a login welcome modal with a
-- team-configurable onboarding checklist. See CLAUDE.md §14 (Workplace admin
-- category).

-- Single flag behind both the modal's "Don't show again" checkbox and the
-- matching My Settings toggle. Default true so a brand-new user sees it.
ALTER TABLE "users" ADD COLUMN "show_flight_deck" boolean NOT NULL DEFAULT true;

CREATE TYPE "flight_deck_link_type" AS ENUM ('app_page', 'external_url');

CREATE TABLE IF NOT EXISTS "flight_deck_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "tooltip" text,
  "icon" text NOT NULL,
  "link_type" "flight_deck_link_type" NOT NULL,
  "link_value" text NOT NULL,
  "is_preset" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Per-locale translations for an item's label/tooltip — same shape and
-- fallback contract as nudge_rule_translations (0083): admin adds one row
-- per language, server resolves to the viewer's active locale, falling back
-- to the base flight_deck_items row when no translation exists.
CREATE TABLE IF NOT EXISTS "flight_deck_item_translations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id" uuid NOT NULL REFERENCES "flight_deck_items"("id") ON DELETE CASCADE,
  "locale" text NOT NULL,
  "label" text NOT NULL,
  "tooltip" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("item_id", "locale")
);

-- Per-user, per-item completion state. Persists across logins even as an
-- admin adds new items later. Deleting the parent item cascades.
CREATE TABLE IF NOT EXISTS "flight_deck_completions" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "item_id" uuid NOT NULL REFERENCES "flight_deck_items"("id") ON DELETE CASCADE,
  "completed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "item_id")
);

-- Role Management matrix: without this row, hasPermission() denies
-- admin.flight_deck for every team_admin whose team already has an explicit
-- permission matrix populated (see 0013/0113's note on this) — the sidebar
-- entry would render but the page itself would be invisible. App Admins
-- bypass the matrix entirely and need no row. Matches the seeding
-- convention used for every sibling team-scoped admin config page
-- (keyword_rules, nudge_rules, capacity, cost_groups): team_admin only, no
-- leader row, since this is a config page, not a leader-facing dashboard.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('team_admin', 'admin.flight_deck', true)
ON CONFLICT (role, page_key) DO NOTHING;
