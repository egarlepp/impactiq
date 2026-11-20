-- v1.225.0: free/busy signal for calendar-derived capacity (CLAUDE.md §12).
-- The Graph $select for calendar events never fetched showAs / isCancelled /
-- responseStatus, so every non-all-day cached event was treated as real busy
-- time — including declined meetings, cancelled meetings, and events marked
-- Free. These three columns store those fields verbatim (never re-encoded)
-- so src/server/services/capacity/meetingLoad.ts can tell real meeting load
-- apart from noise. NULL on every row until the next sync refreshes it.
ALTER TABLE outlook_events ADD COLUMN show_as text;
ALTER TABLE outlook_events ADD COLUMN is_cancelled boolean;
ALTER TABLE outlook_events ADD COLUMN response_status text;
