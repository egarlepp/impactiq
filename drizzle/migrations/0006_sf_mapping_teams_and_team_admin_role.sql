ALTER TYPE "public"."role" ADD VALUE 'team_admin' BEFORE 'admin';--> statement-breakpoint
CREATE TABLE "sf_field_mapping_teams" (
	"sf_field_mapping_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "sf_field_mapping_teams_sf_field_mapping_id_team_id_pk" PRIMARY KEY("sf_field_mapping_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "sf_field_mapping_teams" ADD CONSTRAINT "sf_field_mapping_teams_sf_field_mapping_id_sf_field_mappings_id_fk" FOREIGN KEY ("sf_field_mapping_id") REFERENCES "public"."sf_field_mappings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sf_field_mapping_teams" ADD CONSTRAINT "sf_field_mapping_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill: every existing SF field mapping is assigned to its originating team.
INSERT INTO "sf_field_mapping_teams" ("sf_field_mapping_id", "team_id")
SELECT "id", "team_id" FROM "sf_field_mappings"
ON CONFLICT DO NOTHING;
