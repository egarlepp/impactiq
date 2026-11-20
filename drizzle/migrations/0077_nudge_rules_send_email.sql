-- v1.96.0: per-rule email delivery toggle for nudge rules.
ALTER TABLE "nudge_rules" ADD COLUMN IF NOT EXISTS "send_email" boolean NOT NULL DEFAULT false;
