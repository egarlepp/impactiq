-- v1.386.0: which CriteriaIQ project goes with a CRM Evaluation record, when
-- CriteriaIQ runs as the secondary Project source (CLAUDE.md §9). Only the
-- choices a person made are stored: an Evaluation with exactly one CriteriaIQ
-- project pointing at it links on its own and needs no row. Keyed by the CRM
-- record id, not the activity, since the CriteriaIQ project belongs to the
-- Evaluation and every activity on it should agree. A cache of a CriteriaIQ
-- id, so turning the secondary off and on never needs a migration of its own.
CREATE TABLE "criteriaiq_evaluation_links" (
  "crm_record_id" text PRIMARY KEY,
  "criteriaiq_project_id" integer NOT NULL,
  "linked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "linked_at" timestamptz NOT NULL DEFAULT now()
);
