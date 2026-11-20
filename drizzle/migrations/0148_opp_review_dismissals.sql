-- vNext: "Closed Lost -- Needs Review" dashboard dismissals (see CLAUDE.md §13
-- Manager group / §7 Opportunity Relink). A leader/admin marking one
-- Opportunity as "reviewed, genuinely nothing to relink" so it stops
-- resurfacing in that team's queue. Permanent by design (no expiresAt) --
-- this is a one-time judgment call about an already-closed Opportunity, not
-- a recurring reminder, unlike nudge_dismissals.
CREATE TABLE "opp_review_dismissals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id" uuid NOT NULL REFERENCES "teams"("id"),
  "sf_opp_id" text NOT NULL,
  "sf_opp_name" text NOT NULL,
  "dismissed_by" uuid NOT NULL REFERENCES "users"("id"),
  "dismissed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "opp_review_dismissals_team_id_sf_opp_id_unique" UNIQUE("team_id","sf_opp_id")
);
