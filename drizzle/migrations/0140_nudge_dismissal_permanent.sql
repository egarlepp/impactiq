-- v1.287.0: "Close out" on the weekly-view nudge card is a genuinely
-- permanent dismiss, distinct from Snooze's time-boxed mute. NULL
-- expires_at now means "never re-fire this rule for this user" — the
-- column was NOT NULL because every existing dismissal was a snooze.

ALTER TABLE nudge_dismissals
  ALTER COLUMN expires_at DROP NOT NULL;
