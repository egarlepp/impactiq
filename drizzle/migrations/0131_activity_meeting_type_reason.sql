-- v1.257.0: PRD §7 roadmap — "Meeting activity, if chosen, ask for the
-- reason why so we can understand if there is a need to expand the def of
-- the other activity types or possibly add an additional one." Optional
-- free text, only ever surfaced/collected when the selected activity type
-- is named "Meeting". Not part of any cost/capacity/dashboard math — this
-- is product research data for admins reviewing why reps keep picking the
-- generic type instead of something more specific.

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS meeting_type_reason text;
