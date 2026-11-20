-- Track the auth method (password, okta, totp, backup_code) that minted each
-- session so Login History can distinguish TOTP verifications from backup-code
-- redemptions. Text rather than an enum so future methods (WebAuthn, SSO
-- variants) don't need another migration.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_method text;
