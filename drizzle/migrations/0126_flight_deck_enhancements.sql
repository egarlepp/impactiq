-- v1.250.0: Flight Deck enhancements — optional icon color, screenshots, and
-- a backfill for teams created before Flight Deck shipped (0125). Those teams
-- never got the 4 seeded default items, since applyDefaultTeamConfig() only
-- runs at team-creation time — this inserts the same defaults for any team
-- that currently has zero flight_deck_items rows.

ALTER TABLE "flight_deck_items" ADD COLUMN "icon_color" text;
ALTER TABLE "flight_deck_items" ADD COLUMN "screenshots" text[];

INSERT INTO flight_deck_items (team_id, label, tooltip, icon, link_type, link_value, is_preset, sort_order)
SELECT t.id, d.label, d.tooltip, d.icon, d.link_type::flight_deck_link_type, d.link_value, true, d.sort_order
FROM teams t
CROSS JOIN (VALUES
  ('Complete your profile', 'Set your name, timezone, and work hours so your capacity numbers are accurate.', 'Users', 'app_page', '/settings', 1),
  ('Connect your Salesforce account', 'Link Salesforce so you can attach activities to Opportunities and Accounts.', 'Handshake', 'app_page', '/settings', 2),
  ('Log your first activity', 'Capture a Demo, Discovery, or meeting from your week.', 'Calendar', 'app_page', '/', 3),
  ('Explore your dashboard', 'See your team''s capacity, activity mix, and account coverage.', 'LayoutDashboard', 'app_page', '/dashboard', 4)
) AS d(label, tooltip, icon, link_type, link_value, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM flight_deck_items fdi WHERE fdi.team_id = t.id);
