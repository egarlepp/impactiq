-- v1.78.0: store a friendly label for each connected OAuth account
-- (Salesforce username, Microsoft UPN, …). Populated on the OAuth
-- callback so My Settings can show "Connected as jane@example.com" and
-- admins can debug which mailbox / SF user is wired up.
ALTER TABLE user_integrations
  ADD COLUMN IF NOT EXISTS account_label text;
