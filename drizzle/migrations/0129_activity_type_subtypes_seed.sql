-- v1.255.1: seed Subtype labels (team_activity_type_subtypes) for the
-- default Sales Engineering ("solutions-engineering") team's 9 non-Meeting
-- activity types, per the list provided for deployment. Display-only —
-- never synced to Salesforce (see schema.ts comment on the table).
--
-- Guarded per (team_activity_type_id, name) so a manual re-run never
-- duplicates a row, matching the idempotent-seed convention 0128 used for
-- the Guide text fields.
DO $$
DECLARE
  se_team_id uuid;
  type_id uuid;
BEGIN
  SELECT id INTO se_team_id FROM teams WHERE slug = 'solutions-engineering' LIMIT 1;
  IF se_team_id IS NULL THEN
    RETURN;
  END IF;

  -- Marketing
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Marketing';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Webinar', 1), ('Trade Show / Booth', 2), ('Conference Session', 3),
      ('Roadshow / Field Event', 4), ('Partner Event', 5), ('Customer Event', 6)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- Discovery
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Discovery';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Initial Discovery', 1), ('Technical Discovery', 2), ('Architecture Discovery', 3),
      ('Requirements Gathering', 4), ('Success Criteria / Qualification', 5)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- Demo
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Demo';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Standard Demo', 1), ('Custom Demo', 2), ('Use-Case Demo', 3),
      ('Executive Demo', 4), ('Technical Deep Dive', 5)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- Enablement
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Enablement';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Customer Training', 1), ('Partner Training', 2), ('Admin Training', 3),
      ('How-To / Coaching', 4), ('Configuration Guidance', 5), ('Internal Enablement', 6)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- RFx Work
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'RFx Work';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('RFP', 1), ('RFI', 2), ('Security Questionnaire', 3),
      ('Technical Questionnaire', 4), ('Requirements Matrix', 5), ('Architecture / Compliance Response', 6)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- HealthCheck
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'HealthCheck';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Configuration Review', 1), ('Architecture Review', 2), ('Adoption Review', 3),
      ('Performance / Optimization', 4), ('Best-Practice Review', 5), ('Upgrade / Readiness Review', 6)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- Support
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Support';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Support Handoff', 1), ('Troubleshooting', 2), ('Escalation Call', 3),
      ('Reproduction / Validation', 4), ('Product Issue Review', 5), ('Customer Recovery', 6)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- Eval Work
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Eval Work';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('POC', 1), ('Trial', 2), ('Workshop', 3), ('CloudLAB', 4),
      ('Installation / Configuration', 5), ('Testing / Validation', 6), ('Success Criteria Review', 7)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;

  -- Executive Briefing
  SELECT id INTO type_id FROM team_activity_types WHERE team_id = se_team_id AND name = 'Executive Briefing';
  IF type_id IS NOT NULL THEN
    INSERT INTO team_activity_type_subtypes (team_activity_type_id, name, sort_order)
    SELECT type_id, v.name, v.ord * 10
    FROM (VALUES
      ('Executive Strategy', 1), ('CISO / CIO Briefing', 2), ('Business Value / Outcomes', 3),
      ('Roadmap Discussion', 4), ('Executive Sponsor Meeting', 5), ('Strategic Partnership Review', 6)
    ) AS v(name, ord)
    WHERE NOT EXISTS (SELECT 1 FROM team_activity_type_subtypes s WHERE s.team_activity_type_id = type_id AND s.name = v.name);
  END IF;
END $$;
