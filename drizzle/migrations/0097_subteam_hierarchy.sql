-- v1.177.0: subteam hierarchy. A subteam can nest under another subteam in the
-- same team, up to 4 levels deep. Null parent = top-level. Depth + cycle are
-- enforced in the application layer (admin.ts assertSubteamDepthOk).
ALTER TABLE "subteams" ADD COLUMN "parent_subteam_id" uuid REFERENCES "subteams"("id") ON DELETE SET NULL;
CREATE INDEX "idx_subteams_parent" ON "subteams" ("parent_subteam_id");
