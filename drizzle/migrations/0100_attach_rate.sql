-- v1.187.0: Attach Rate dashboard — measures the share of Opportunities
-- that have a Solutions Engineer attached. Adds the team-scoped, admin-
-- editable field config that defines "attached", seeds it with the four
-- proven Opportunity SE fields per team, and registers the dashboard in
-- the role-permission matrix.

CREATE TABLE IF NOT EXISTS "attach_rate_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "sf_object" text NOT NULL,
  "field_api" text NOT NULL,
  "match_type" text DEFAULT 'equals' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);--> statement-breakpoint

-- Seed the default SE-assignment fields for every existing team. Guarded
-- by NOT EXISTS since there's no unique constraint (admins may later add
-- or remove rows). Supporting_Engineers__c is a multi-select, so it uses
-- the INCLUDES match; the other three are single lookups (equals/not-null).
INSERT INTO "attach_rate_fields" (team_id, sf_object, field_api, match_type, is_active)
SELECT DISTINCT t.id, 'Opportunity', x.field_api, x.match_type, true
FROM teams t
CROSS JOIN (
  VALUES
    ('Assigned_SE__c', 'equals'),
    ('Primary_Engineer__c', 'equals'),
    ('Specialist_Engineer__c', 'equals'),
    ('Supporting_Engineers__c', 'includes')
) AS x(field_api, match_type)
WHERE NOT EXISTS (
  SELECT 1 FROM "attach_rate_fields" a
  WHERE a.team_id = t.id AND a.sf_object = 'Opportunity' AND a.field_api = x.field_api
);--> statement-breakpoint

-- Register the dashboard tab in the role-permission matrix. The tab gates
-- on 'dashboard.attachRate'; grant it for leaders and team admins (app
-- admins are always full-access). Existing rows keep any admin-set value.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('leader',     'dashboard.attachRate', true),
  ('team_admin', 'dashboard.attachRate', true)
ON CONFLICT (role, page_key) DO NOTHING;
