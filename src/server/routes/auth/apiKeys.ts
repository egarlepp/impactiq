import { Router } from 'express'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { hasAnyLeaderOrAdminRole } from '../../middleware/rbac.js'
import { requireAuth } from '../../middleware/auth.js'
import { apiKeys as apiKeysTbl, users } from '../../../../drizzle/schema.js'
import { desc, isNull } from 'drizzle-orm'
import { hashRawKey, keyPrefix, newRawApiKey } from '../../services/auth/apiKeys.js'

export const apiKeysAuthRoutes = Router()

async function isAppAdminUser(userId: string): Promise<boolean> {
  const [row] = await db.select({ isAppAdmin: users.isAppAdmin }).from(users).where(eq(users.id, userId)).limit(1)
  return row?.isAppAdmin === true
}

// ── API Keys ──────────────────────────────────────────────────────────────

// GET /auth/api-keys — list the caller's active keys (no plaintext, ever).
apiKeysAuthRoutes.get('/api-keys', requireAuth, async (req, res) => {
  const rows = await db
    .select({
      id: apiKeysTbl.id,
      name: apiKeysTbl.name,
      keyPrefix: apiKeysTbl.keyPrefix,
      lastUsedAt: apiKeysTbl.lastUsedAt,
      expiresAt: apiKeysTbl.expiresAt,
      createdAt: apiKeysTbl.createdAt,
      scopes: apiKeysTbl.scopes,
    })
    .from(apiKeysTbl)
    .where(and(eq(apiKeysTbl.userId, req.user!.id), isNull(apiKeysTbl.revokedAt)))
    .orderBy(desc(apiKeysTbl.createdAt))
  res.json({ data: rows, error: null, meta: {} })
})

const VALID_SCOPES = ['rest:full', 'mcp:read', 'effort:read', 'activities:log'] as const
// POST /auth/api-keys — mint a new key. The plaintext is returned ONCE.
apiKeysAuthRoutes.post('/api-keys', requireAuth, async (req, res) => {
  const parsed = z.object({
    name: z.string().min(1).max(80),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
    scopes: z.array(z.enum(VALID_SCOPES)).min(1).max(4).optional(),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ data: null, error: parsed.error.message, meta: {} }); return }
  const scopes = parsed.data.scopes && parsed.data.scopes.length > 0 ? parsed.data.scopes : ['rest:full']
  // v1.288.0: security audit finding B2 — an mcp:read key reaches the MCP
  // server's tools (dashboards, cross-team activity search, an org-wide
  // Salesforce Opportunity search), which is materially broader than a
  // Contributor's own session permissions. Self-issuing that scope was
  // previously open to any authenticated user with no role check at all.
  // rest:full is unaffected — it only ever acts with the caller's own
  // existing permissions, so there's nothing to escalate there.
  // v1.448.0: effort:read (GET /api/v1/effort, for CriteriaIQ) returns
  // per-person hours across the owner's teams, so it has the same gate.
  if ((scopes.includes('mcp:read') || scopes.includes('effort:read')) && !(await hasAnyLeaderOrAdminRole(req.user!.id))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  // v1.481.0: activities:log (POST /api/v1/activities/log, for DemoIQ) logs a
  // draft activity for ANY user named by email, so only an App Admin may hold it.
  if (scopes.includes('activities:log') && !(await isAppAdminUser(req.user!.id))) {
    res.status(403).json({ data: null, error: 'errors.forbidden', meta: {} })
    return
  }
  const raw = newRawApiKey()
  const { salt, hash } = hashRawKey(raw)
  const expiresAt = parsed.data.expiresInDays ? new Date(Date.now() + parsed.data.expiresInDays * 86400_000) : null
  const [row] = await db.insert(apiKeysTbl).values({
    userId: req.user!.id,
    name: parsed.data.name,
    keyHash: hash,
    keySalt: salt,
    keyPrefix: keyPrefix(raw),
    expiresAt,
    scopes,
  }).returning({ id: apiKeysTbl.id })
  res.status(201).json({
    data: { id: row!.id, name: parsed.data.name, key: raw, keyPrefix: keyPrefix(raw), expiresAt, scopes },
    error: null,
    meta: { showKeyOnce: true },
  })
})

// DELETE /auth/api-keys/:id — revoke.
apiKeysAuthRoutes.delete('/api-keys/:id', requireAuth, async (req, res) => {
  const { id } = req.params as { id: string }
  const result = await db.update(apiKeysTbl)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeysTbl.id, id), eq(apiKeysTbl.userId, req.user!.id), isNull(apiKeysTbl.revokedAt)))
    .returning({ id: apiKeysTbl.id })
  if (result.length === 0) { res.status(404).json({ data: null, error: 'errors.not_found', meta: {} }); return }
  res.json({ data: { id }, error: null, meta: {} })
})
