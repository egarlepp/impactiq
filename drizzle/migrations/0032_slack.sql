-- Slack notification transport. Per-team bot app; admin registers the Slack
-- app once, `slack_config` in system_settings stores the bot token + signing
-- secret. Per-user slack_user_id is populated by an admin-triggered lookup
-- against Slack's users.lookupByEmail so we can DM contributors from the bot.
ALTER TABLE users ADD COLUMN slack_user_id text;
CREATE INDEX users_slack_user_id ON users (slack_user_id);
