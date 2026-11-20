-- v1.113.0: Email Communications admin registry. Each outbound email
-- code path has a row here keyed by a stable string; the sender checks
-- is_active before dispatching. Subject / body templates are optional
-- overrides (null falls back to hard-coded defaults in the sender for
-- now — full template editing lands in v1.114).
CREATE TABLE IF NOT EXISTS "email_rules" (
  "key"              text PRIMARY KEY,
  "name"             text NOT NULL,
  "description"      text,
  "is_active"        boolean NOT NULL DEFAULT true,
  "subject_template" text,
  "body_template"    text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "email_rules" ("key", "name", "description", "is_active") VALUES
  ('login_new_location', 'New sign-in alert', 'Sent to a user the first time we see a sign-in from a new IP address (90-day lookback). Fires on every successful login (password, MFA, Okta).', true),
  ('weekly_recap', 'Weekly recap', 'Personalised summary of the user''s submitted activities for the week: total hours vs capacity, hours by activity type, top Opportunities by hours. Scheduled to a per-user local weekday/hour.', true),
  ('daily_digest', 'Daily notification digest', 'Rolls up every notification created since the user''s last digest into a single email once per local day. Includes nudges and system notifications.', true),
  ('nudge_email', 'Nudge (Also send by email)', 'Per-rule opt-in on Admin → Nudge Rules. When a nudge rule''s "Also send by email" is on, the in-app card is also delivered as an email using this rule.', true),
  ('admin_test_email', 'Admin test email', 'Manual test send from Admin → Integrations → Email → "Send test". Recipient is the address the admin types.', true),
  ('smtp_test', 'SMTP test connection', 'Manual test send from Admin → Integrations → Email → "Test Connection". Sends a fixed-body verification to the admin''s own email.', true)
ON CONFLICT ("key") DO NOTHING;
