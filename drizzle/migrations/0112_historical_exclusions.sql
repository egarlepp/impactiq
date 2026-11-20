-- v1.215.0: exclusion lists for the historical Salesforce Event import.
--
-- A sales-engagement integration (Outreach, for example) can create a large
-- share of an org's linked Events, most of them Type 'Meeting'. Importing those
-- would make the largest activity type in the history meaningless.
--
-- These cannot be detected heuristically: the Outreach user has
-- UserType = 'Standard' and profile 'System Administrator', identical to a
-- human account. Same for ZoomInfo, GONG, and Marketo. Hence an explicit,
-- admin-managed list rather than a rule.
--
-- Note on retention: purging events via an exclusion rule deletes rows from
-- sf_historical_events only. It never touches sf_historical_import_runs, so
-- the provenance invariant documented in 0111 still holds.

-- Creator provenance on each imported event. Needed to enforce and audit
-- created_by exclusions, and to power the admin's "top creators" discovery
-- panel so nobody has to hunt for User Ids in Salesforce.
ALTER TABLE sf_historical_events
  ADD COLUMN IF NOT EXISTS created_by_sf_user_id   text,
  ADD COLUMN IF NOT EXISTS created_by_sf_user_name text;

CREATE INDEX IF NOT EXISTS idx_hist_events_created_by
  ON sf_historical_events (created_by_sf_user_id)
  WHERE created_by_sf_user_id IS NOT NULL;

-- One table with a closed two-value discriminator rather than two tables:
-- the created_by and owner lists are structurally identical (same columns,
-- same lifecycle, same audit actions, same UI) and differ only in which event
-- column the predicate targets. The composite PK is deliberate — the same SF
-- Id can legitimately appear in both lists, and the two rules are independent.
CREATE TABLE IF NOT EXISTS sf_historical_exclusions (
  kind           text NOT NULL CHECK (kind IN ('created_by', 'owner')),
  sf_user_id     text NOT NULL,
  label          text,
  note           text,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_purged_at timestamptz,
  purged_count   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, sf_user_id)
);

CREATE INDEX IF NOT EXISTS idx_hist_excl_active
  ON sf_historical_exclusions (kind) WHERE is_active;

-- Distinct from events_skipped, which means "malformed, no Id". Conflating
-- the two would make the run history lie about why rows didn't land.
ALTER TABLE sf_historical_import_runs
  ADD COLUMN IF NOT EXISTS events_excluded integer NOT NULL DEFAULT 0;

-- No exclusions are seeded: automation users differ per Salesforce org. An
-- admin adds them from CRM Historical Import (the top-creators panel lists
-- likely candidates such as sales-engagement or scheduling tools).
