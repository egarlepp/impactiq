-- TOTP-based MFA for password-authenticated users. Okta users are unaffected —
-- their MFA lives at the IdP layer.
--
-- totp_secret_encrypted   AES-256-GCM ciphertext of the base32 shared secret,
--                          set once at enrollment. Never re-exposed to the user.
-- totp_enrolled_at        Set when enrollment completes; a null value on a
--                          password-authenticated account forces enrollment on
--                          next login.
-- mfa_backup_codes_hash   jsonb array of scrypt-hashed single-use recovery
--                          codes. Consumed on use; regenerated wipes and
--                          replaces the whole array.
ALTER TABLE users ADD COLUMN totp_secret_encrypted text;
ALTER TABLE users ADD COLUMN totp_enrolled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_backup_codes_hash jsonb;
