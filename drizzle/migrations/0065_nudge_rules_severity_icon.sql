-- Batch A of the nudge polish work (v1.62.0):
-- • `severity` — drives notification card color + email urgency.
-- • `icon` — optional lucide icon name; renders as a small chip on the card.
-- Both admin-editable per rule. Nulls fall back to sensible defaults on the client.
ALTER TABLE nudge_rules
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS icon text;

-- Notifications carry severity + icon inline so the bell card can render
-- without joining back to nudge_rules on every list fetch. Non-nudge kinds
-- (system, workflow, etc.) inherit the 'info' default.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS icon text;
