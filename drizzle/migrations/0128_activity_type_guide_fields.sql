-- v1.255.0: Activity Type Guide fields (Use This When / Usually Attach To /
-- Examples), a per-type Subtypes list (display-only, not wired into
-- classification yet), and a team-scoped "Distinctions" free-text block —
-- all surfaced read-only on the new Guide sidebar page so reps have an
-- in-app reference instead of an external doc. See CLAUDE.md §11-ish /
-- ActivityTypesConfig.tsx's "Classify Activity" section for the admin side.

ALTER TABLE team_activity_types
  ADD COLUMN IF NOT EXISTS use_this_when text,
  ADD COLUMN IF NOT EXISTS usually_attach_to text,
  ADD COLUMN IF NOT EXISTS examples text;

CREATE TABLE IF NOT EXISTS team_activity_type_subtypes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_activity_type_id uuid NOT NULL REFERENCES team_activity_types(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS guide_distinctions text;

-- Register the new Guide page in the role-permission matrix, granted for
-- every non-app-admin role (app admins are always full-access) — same
-- convention as 0093_seed_scheduling_notes_permissions.sql.
INSERT INTO role_permissions (role, page_key, has_access) VALUES
  ('contributor', 'guide', true),
  ('leader',      'guide', true),
  ('team_admin',  'guide', true)
ON CONFLICT (role, page_key) DO NOTHING;

-- Seed the Guide content the owner provided for the default Sales Engineering
-- ("solutions-engineering") team's 9 non-Meeting activity types. Only
-- fills currently-blank rows so a re-run (or a prior manual edit) is never
-- clobbered; other teams start blank and simply won't show a card until
-- an admin fills them in.
DO $$
DECLARE
  se_team_id uuid;
BEGIN
  SELECT id INTO se_team_id FROM teams WHERE slug = 'solutions-engineering' LIMIT 1;
  IF se_team_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re supporting a marketing-led activity rather than working a specific sales opportunity.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Marketing Campaign'),
    examples = COALESCE(examples, 'Webinar, trade show booth, conference session, roadshow, customer event')
  WHERE team_id = se_team_id AND name = 'Marketing';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re learning about the customer''s environment, requirements, problems, priorities, or technical fit.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Opportunity if it exists; otherwise Account'),
    examples = COALESCE(examples, 'Technical discovery call, architecture discussion, requirements gathering, qualification call')
  WHERE team_id = se_team_id AND name = 'Discovery';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re showing product capabilities to address a customer''s stated or anticipated requirements.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Opportunity'),
    examples = COALESCE(examples, 'Product demo, use-case demo, architecture walkthrough with product, custom demo')
  WHERE team_id = se_team_id AND name = 'Demo';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re teaching someone how to use, configure, position, or understand the product rather than actively proving it for a sale.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Account or Opportunity, depending on context'),
    examples = COALESCE(examples, 'Customer training, admin walkthrough, "how do I...?", simple configuration assistance, partner enablement')
  WHERE team_id = se_team_id AND name = 'Enablement';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re responding to a formal or semi-formal customer requirements document.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Opportunity; one activity per RFx request'),
    examples = COALESCE(examples, 'RFP, RFI, security questionnaire, technical questionnaire, requirements matrix')
  WHERE team_id = se_team_id AND name = 'RFx Work';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re proactively reviewing an existing customer environment to assess configuration, adoption, architecture, or product health.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Account'),
    examples = COALESCE(examples, 'Deployment review, configuration assessment, adoption review, optimization session')
  WHERE team_id = se_team_id AND name = 'HealthCheck';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re participating in a strategic, executive-level customer conversation focused on business priorities, security strategy, transformation initiatives, risk, outcomes, or partnership direction rather than detailed product evaluation or technical discovery.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Opportunity if tied to an active deal; otherwise Account.'),
    examples = COALESCE(examples, 'Executive briefing, CISO/CIO meeting, strategic roadmap discussion, executive sponsor meeting, business-value discussion, transformation planning, customer executive workshop.')
  WHERE team_id = se_team_id AND name = 'Executive Briefing';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''ve become involved in a customer issue that is primarily troubleshooting/support rather than presales.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Account, or Opportunity when directly connected to an active deal'),
    examples = COALESCE(examples, 'Escalation call, troubleshooting with Support, reproduction assistance, critical customer issue')
  WHERE team_id = se_team_id AND name = 'Support';

  UPDATE team_activity_types SET
    use_this_when = COALESCE(use_this_when, 'You''re doing hands-on technical work required to execute an evaluation.'),
    usually_attach_to = COALESCE(usually_attach_to, 'Opportunity + Evaluation record'),
    examples = COALESCE(examples, 'POC setup, trial configuration, workshop, CloudLAB, CDSA, installation, success-criteria testing')
  WHERE team_id = se_team_id AND name = 'Eval Work';

  UPDATE teams SET guide_distinctions = COALESCE(guide_distinctions,
E'Discovery vs Demo:\nDiscovery = "Tell me about your world."\nDemo = "Let me show you how we address what we learned."\nA discovery call that happens to include five minutes of product does not suddenly become a Demo.\n\nDemo vs Eval Work:\nDemo = SE shows it.\nEval Work = customer is proving it, and the SE is installing, configuring, testing, or otherwise facilitating the proof.\n\nEnablement vs Support:\nEnablement = "Here''s how you do it."\nSupport = "Something isn''t working; let''s figure out why."\n\nHealth Check vs Support:\nHealth Check = proactive/preventative.\nSupport = reactive/problem-driven.\n\nDiscovery vs Eval Work:\nA success-criteria planning conversation can still be Discovery. Once the SE starts executing the technical evaluation—install, configure, test, validate—that is Eval Work.')
  WHERE id = se_team_id;
END $$;
