import jsforce from 'jsforce'
import { db } from '../../db/index.js'
import { userIntegrations, systemSettings } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import {
  decryptToken,
  encryptToken,
  refreshAccessToken,
} from '../auth/salesforce.js'
import { CLEARED_USER_INTEGRATION_ERROR, markUserIntegrationFailed, recordIntegrationCall } from '../health/integrationStatus.js'

const REFRESH_SKEW_MS = 60 * 1000 // refresh if token expires within 60 seconds
export const ADMIN_SF_SETTINGS_KEY = 'salesforce_admin_connection'

export interface AdminSfConnectionRecord {
  userId: string
  accessTokenEncrypted: string
  refreshTokenEncrypted: string | null
  instanceUrl: string
  expiresAt: string
  updatedAt: string
}

export async function getSfConnection(userId: string): Promise<jsforce.Connection | null> {
  const [integration] = await db
    .select()
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'salesforce')))
    .limit(1)

  if (!integration?.accessTokenEncrypted) return null

  let accessToken = decryptToken(integration.accessTokenEncrypted)
  let instanceUrl = integration.instanceUrl ?? 'https://login.salesforce.com'

  // Refresh if expired (or close to it) and we have a refresh token.
  const expiresAt = integration.expiresAt?.getTime() ?? null
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() < REFRESH_SKEW_MS

  if (needsRefresh && integration.refreshTokenEncrypted) {
    const refreshToken = decryptToken(integration.refreshTokenEncrypted)
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>
    try {
      refreshed = await refreshAccessToken(refreshToken, instanceUrl)
    } catch (err) {
      // App Health counts this user as needing to reconnect Salesforce.
      await markUserIntegrationFailed(integration.id, err)
      recordIntegrationCall('salesforce', false, err)
      throw err
    }
    recordIntegrationCall('salesforce', true)
    accessToken = refreshed.access_token
    instanceUrl = refreshed.instance_url ?? instanceUrl
    await db
      .update(userIntegrations)
      .set({
        ...CLEARED_USER_INTEGRATION_ERROR,
        accessTokenEncrypted: encryptToken(accessToken),
        instanceUrl,
        // Salesforce access tokens have no fixed TTL in the response; SF returns issued_at only.
        // Bump expiresAt 2h out as a working assumption; the next refresh-on-401 path will recover.
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .where(eq(userIntegrations.id, integration.id))
  }

  return new jsforce.Connection({ accessToken, instanceUrl })
}

// The admin SF connection is org-wide (only one at a time) and used only for
// metadata introspection — never for reading or writing user-scoped data.
export async function getAdminSfConnectionRecord(): Promise<AdminSfConnectionRecord | null> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY)).limit(1)
  return (row?.value as AdminSfConnectionRecord | undefined) ?? null
}

export async function getAdminSfConnection(): Promise<jsforce.Connection | null> {
  const record = await getAdminSfConnectionRecord()
  if (!record?.accessTokenEncrypted) return null

  let accessToken = decryptToken(record.accessTokenEncrypted)
  let instanceUrl = record.instanceUrl

  const expiresAt = record.expiresAt ? new Date(record.expiresAt).getTime() : null
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() < REFRESH_SKEW_MS

  if (needsRefresh && record.refreshTokenEncrypted) {
    const refreshToken = decryptToken(record.refreshTokenEncrypted)
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>
    try {
      refreshed = await refreshAccessToken(refreshToken, instanceUrl)
    } catch (err) {
      recordIntegrationCall('salesforce', false, err)
      throw err
    }
    recordIntegrationCall('salesforce', true)
    accessToken = refreshed.access_token
    instanceUrl = refreshed.instance_url ?? instanceUrl
    const next: AdminSfConnectionRecord = {
      ...record,
      accessTokenEncrypted: encryptToken(accessToken),
      instanceUrl,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await db
      .update(systemSettings)
      .set({ value: next, updatedAt: new Date() })
      .where(eq(systemSettings.key, ADMIN_SF_SETTINGS_KEY))
  }

  return new jsforce.Connection({ accessToken, instanceUrl })
}
