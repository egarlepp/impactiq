-- Batch C of the nudge polish work (v1.64.0):
-- • `slack_webhook_url` on teams — admin-pasted Incoming Webhook URL.
--   When set, every nudge fired for a member of this team also POSTs a
--   short card to the webhook (channel-agnostic, workspace picks the
--   destination on webhook creation). NULL disables Slack delivery.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS slack_webhook_url text;
