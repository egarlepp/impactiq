-- Per-user notification preferences (email transport + cadence)
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled    boolean NOT NULL DEFAULT false,
  -- 'graph' = send via user's Outlook OAuth; 'smtp' = via server SMTP relay
  email_transport  text NOT NULL DEFAULT 'graph',
  -- IANA timezone used to compute the 8am local digest time. Defaults to UTC
  -- so a user that never set a TZ still gets a digest, just at UTC 8am.
  timezone         text NOT NULL DEFAULT 'UTC',
  -- Last time a digest was sent. Used to prevent duplicate sends and to scope
  -- "notifications since the last digest" for the email body.
  last_digest_at   timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
