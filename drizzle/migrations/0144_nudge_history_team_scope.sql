-- v1.324.0: Nudge Dismissals merges into Nudge History as a tab (see
-- CLAUDE.md). Nudge History moves from App-Admin-only to team-scoped, like
-- every other nudge-rules page -- team_admin previously had an explicit
-- FALSE grant for it (migration 0113, back when it really was App-Admin
-- only), so it needs an explicit TRUE now or the merged page's sidebar
-- entry and both tabs would never show up for a team_admin.
INSERT INTO role_permissions (role, page_key, has_access)
VALUES ('team_admin', 'admin.nudge_history', true)
ON CONFLICT (role, page_key) DO UPDATE SET has_access = true;
--> statement-breakpoint

-- admin.nudge_dismissals is no longer a distinct page (folded into
-- admin.nudge_history's Dismissals tab) -- these rows are dead config now
-- that nothing reads that page_key anymore.
DELETE FROM role_permissions WHERE page_key = 'admin.nudge_dismissals';
