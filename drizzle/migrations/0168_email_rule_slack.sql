-- v1.436.0: Admin → Communications "Also send as Slack DM" per rule.
ALTER TABLE "email_rules" ADD COLUMN IF NOT EXISTS "send_slack" boolean DEFAULT false NOT NULL;
