-- v1.115.0: seed the welcome + invitation email rules so the
-- template editor + Send Test work before the corresponding user
-- create flows are wired. password_reset lands in v1.116.
INSERT INTO "email_rules" ("key", "name", "description", "is_active") VALUES
  ('welcome', 'Welcome email', 'Sent when an admin creates a new user with "Send welcome email" ticked. Announces access with a link to sign in.', true),
  ('invitation', 'Invitation email (first-time user)', 'Sent when an admin creates a new user with "Send invitation" ticked. Includes the initial password; the user is required to change it on first sign-in.', true)
ON CONFLICT ("key") DO NOTHING;
