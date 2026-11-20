-- v1.319.0: meeting owner's email, kept alongside the existing meeting_owner
-- (name only) column rather than folding into one combined string. Two
-- people can share a display name across different orgs, so the email is
-- needed to disambiguate on the activity card (shown on hover) and in the
-- edit form (shown inline, matching the existing "Name <email>" convention
-- already used for attendees). Never sent to Salesforce.
ALTER TABLE activities
  ADD COLUMN meeting_owner_email text;
