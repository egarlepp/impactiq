-- Timezone source (v1.469.0). A user can now set their timezone by hand, or
-- keep their CRM's, and that choice sticks: the hourly Outlook mailbox check
-- only changes users.timezone while timezone_source is 'auto'.
--   auto   = follow Outlook when connected (UTC until then)
--   crm    = the user picked their CRM's timezone
--   manual = the user picked a timezone from the list
-- outlook_timezone keeps the mailbox's own timezone so Settings can offer it
-- back even while the user has overridden it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_source text NOT NULL DEFAULT 'auto';
ALTER TABLE users ADD COLUMN IF NOT EXISTS outlook_timezone text;
-- Re-read every connected mailbox on the next calendar poll so outlook_timezone
-- fills in for users who connected Outlook before this release.
UPDATE users SET timezone_checked_at = NULL WHERE timezone_checked_at IS NOT NULL;
