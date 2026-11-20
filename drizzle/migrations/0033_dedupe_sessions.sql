-- Clean up duplicate rows created by v1.15.0's per-request legacy-cookie
-- upgrade. Keep one row per (user_id, ip, user_agent, token_hash-was-unique)
-- with the most recent last_used_at, revoke the rest so Active Sessions
-- doesn't show a wall of copies.
UPDATE sessions
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND id NOT IN (
     SELECT DISTINCT ON (user_id, coalesce(ip, ''), coalesce(user_agent, '')) id
       FROM sessions
      WHERE revoked_at IS NULL
      ORDER BY user_id, coalesce(ip, ''), coalesce(user_agent, ''), last_used_at DESC
   );
