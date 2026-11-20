-- v1.225.0: admin opt-in, per capacity group — shows the calendar-derived
-- "Meeting Load" figure (real, accepted, non-cancelled Outlook meeting hours)
-- alongside logged/target hours on leader dashboards for that group's
-- members. Independent of capacity_method: a fixed_hours group can enable
-- this signal without switching its target-setting method.
ALTER TABLE capacity_groups ADD COLUMN show_real_meeting_load boolean NOT NULL DEFAULT false;
