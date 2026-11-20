ALTER TABLE "keyword_rules" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "nudge_rules" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "team_activity_types" ALTER COLUMN "team_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_app_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_see_all_teams" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users" SET "is_app_admin" = true, "can_see_all_teams" = true WHERE "okta_id" LIKE 'bootstrap:%';