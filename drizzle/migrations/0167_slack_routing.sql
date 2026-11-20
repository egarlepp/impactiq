-- v1.433.0: Slack DMs for nudges and announcements.
ALTER TABLE "nudge_rules" ADD COLUMN IF NOT EXISTS "send_slack_dm" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_notification_prefs" ADD COLUMN IF NOT EXISTS "slack_dm_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "send_slack" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "slack_sent_at" timestamp with time zone;
