-- Link an ImpactIQ team to a Salesforce User.Department value.
-- Kept as text (not FK) because SF Departments are a picklist /
-- free-text on the User object and don't have their own SObject.
-- Team-scoped filters (Sales Team Alignment, dashboards) can use
-- this to auto-scope to SF users whose Department matches.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS sf_department text;
