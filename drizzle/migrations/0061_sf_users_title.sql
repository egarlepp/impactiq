-- Cache the Salesforce User's Title alongside name/email/manager so
-- User Management can surface Title and Manager under the Linked SF User
-- picker without re-hitting Salesforce on every edit.
ALTER TABLE sf_users
  ADD COLUMN IF NOT EXISTS title text;
