-- Clean up duplicate active sessions that accumulated before the
-- v1.27.0 fingerprint-dedup in issueSession(). Keep the newest row per
-- (user_id, ip, user_agent) fingerprint (where BOTH ip AND ua are set,
-- so we don't nuke legitimate parallel logins with missing metadata).
UPDATE sessions
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND ip IS NOT NULL
   AND user_agent IS NOT NULL
   AND id NOT IN (
     SELECT DISTINCT ON (user_id, ip, user_agent) id
       FROM sessions
      WHERE revoked_at IS NULL
        AND ip IS NOT NULL
        AND user_agent IS NOT NULL
      ORDER BY user_id, ip, user_agent, last_used_at DESC NULLS LAST, created_at DESC
   );
