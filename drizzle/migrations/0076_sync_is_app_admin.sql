-- v1.94.0: correct any user who holds team_members.role='admin' on at
-- least one team but somehow has users.is_app_admin=false. v1.81 wired
-- this sync at insert / role-patch time, but rows created before that
-- release (or via the demo generator) still drift. One-shot backfill so
-- Admin sees themes / role management on next reload.
UPDATE users
SET is_app_admin = true, updated_at = now()
WHERE is_app_admin = false
  AND id IN (SELECT DISTINCT user_id FROM team_members WHERE role = 'admin');
