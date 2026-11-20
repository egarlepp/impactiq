CREATE TABLE "activity_type_teams" (
	"activity_type_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "activity_type_teams_activity_type_id_team_id_pk" PRIMARY KEY("activity_type_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "keyword_rule_teams" (
	"keyword_rule_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "keyword_rule_teams_keyword_rule_id_team_id_pk" PRIMARY KEY("keyword_rule_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "nudge_rule_teams" (
	"nudge_rule_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "nudge_rule_teams_nudge_rule_id_team_id_pk" PRIMARY KEY("nudge_rule_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "activity_type_teams" ADD CONSTRAINT "activity_type_teams_activity_type_id_team_activity_types_id_fk" FOREIGN KEY ("activity_type_id") REFERENCES "public"."team_activity_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_type_teams" ADD CONSTRAINT "activity_type_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_rule_teams" ADD CONSTRAINT "keyword_rule_teams_keyword_rule_id_keyword_rules_id_fk" FOREIGN KEY ("keyword_rule_id") REFERENCES "public"."keyword_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_rule_teams" ADD CONSTRAINT "keyword_rule_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudge_rule_teams" ADD CONSTRAINT "nudge_rule_teams_nudge_rule_id_nudge_rules_id_fk" FOREIGN KEY ("nudge_rule_id") REFERENCES "public"."nudge_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudge_rule_teams" ADD CONSTRAINT "nudge_rule_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Migrate existing team-scoped rows into junction tables.
-- Rows with team_id set: assign to that team.
-- Rows with team_id IS NULL (previously "all teams"): assign to every active team.
INSERT INTO "activity_type_teams" ("activity_type_id", "team_id")
  SELECT t.id, t.team_id FROM "team_activity_types" t WHERE t.team_id IS NOT NULL
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "activity_type_teams" ("activity_type_id", "team_id")
  SELECT t.id, tm.id FROM "team_activity_types" t CROSS JOIN "teams" tm
  WHERE t.team_id IS NULL AND tm.is_active = true
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "keyword_rule_teams" ("keyword_rule_id", "team_id")
  SELECT k.id, k.team_id FROM "keyword_rules" k WHERE k.team_id IS NOT NULL
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "keyword_rule_teams" ("keyword_rule_id", "team_id")
  SELECT k.id, tm.id FROM "keyword_rules" k CROSS JOIN "teams" tm
  WHERE k.team_id IS NULL AND tm.is_active = true
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "nudge_rule_teams" ("nudge_rule_id", "team_id")
  SELECT n.id, n.team_id FROM "nudge_rules" n WHERE n.team_id IS NOT NULL
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "nudge_rule_teams" ("nudge_rule_id", "team_id")
  SELECT n.id, tm.id FROM "nudge_rules" n CROSS JOIN "teams" tm
  WHERE n.team_id IS NULL AND tm.is_active = true
  ON CONFLICT DO NOTHING;