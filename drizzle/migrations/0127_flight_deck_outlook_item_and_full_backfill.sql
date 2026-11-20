-- v1.251.0: adds the 5th Flight Deck default item (Connect your Outlook
-- account) and widens the backfill from "teams with zero flight_deck_items
-- rows" (0126) to "teams missing THIS SPECIFIC default item by label".
--
-- 0126's backfill only fired for a team with zero rows at migration time.
-- In practice several teams already had at least one custom item (created
-- between Flight Deck's initial ship and this fix) and so never got any of
-- the defaults at all — see the report that a real team showed only its own
-- custom item with none of the 4 seeded ones. Checking existence per-item
-- by label, not per-team by row count, fixes both that gap and adds the new
-- Outlook item everywhere it's missing (including teams that DID get 0126's
-- backfill, so they don't have to re-run anything to pick up item #5).
INSERT INTO flight_deck_items (team_id, label, tooltip, icon, link_type, link_value, is_preset, sort_order)
SELECT t.id, d.label, d.tooltip, d.icon, d.link_type::flight_deck_link_type, d.link_value, true, d.sort_order
FROM teams t
CROSS JOIN (VALUES
  ('Complete your profile', 'Set your name, timezone, and work hours so your capacity numbers are accurate.', 'Users', 'app_page', '/settings', 1),
  ('Connect your Salesforce account', 'Link Salesforce so you can attach activities to Opportunities and Accounts.', 'Handshake', 'app_page', '/settings', 2),
  ('Connect your Outlook account', 'Link Outlook so your calendar events show up for logging activities.', 'CalendarDays', 'app_page', '/settings', 3),
  ('Log your first activity', 'Capture a Demo, Discovery, or meeting from your week.', 'Calendar', 'app_page', '/', 4),
  ('Explore your dashboard', 'See your team''s capacity, activity mix, and account coverage.', 'LayoutDashboard', 'app_page', '/dashboard', 5)
) AS d(label, tooltip, icon, link_type, link_value, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM flight_deck_items fdi WHERE fdi.team_id = t.id AND fdi.label = d.label
);
