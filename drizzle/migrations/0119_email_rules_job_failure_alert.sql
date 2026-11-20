-- v1.230.0: "Email admins on error" (job_config.notify_on_error) previously
-- sent a hardcoded email directly, bypassing Admin -> Communications
-- entirely — no Active/Inactive gate, no customizable subject/body, and
-- invisible on the rules list. Seed a rule for it so it goes through the
-- same sendByRule() path every other outbound email in this app uses.
INSERT INTO "email_rules" ("key", "name", "description", "is_active") VALUES
  ('job_failure_alert', 'Scheduled job failure alert', 'Sent to app admins who opted in via Admin → Scheduling → "Email admins on error" when a background job run ends in error. Deduped to at most one email per admin per job per day.', true)
ON CONFLICT ("key") DO NOTHING;
