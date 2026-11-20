import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { systemSettings } from '../../../../drizzle/schema.js'

const KEY = 'auth_policy'
const GROUP_SETTINGS_KEY = 'okta_group_settings'

export interface AuthPolicy {
  requirePrecreatedUser: boolean
}

export interface OktaGroupSettings {
  groupClaimName: string
  defaultRole: 'contributor' | 'leader' | 'team_admin'
  defaultTeamId: string | null
  // Off by default — Okta's default authorization server does not ship
  // with a `groups` scope, and requesting an undefined scope fails the
  // /authorize call with invalid_scope. Admins enable this only after
  // adding a `groups` scope + matching claim to their Okta auth server.
  requestGroupsScope: boolean
}

const DEFAULT_POLICY: AuthPolicy = { requirePrecreatedUser: true }
const DEFAULT_GROUP_SETTINGS: OktaGroupSettings = {
  groupClaimName: 'groups',
  defaultRole: 'contributor',
  defaultTeamId: null,
  requestGroupsScope: false,
}

let cached: AuthPolicy | null = null
let cachedGroups: OktaGroupSettings | null = null

async function readKey<T>(key: string): Promise<T | undefined> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1)
  return row?.value as T | undefined
}

async function upsert(key: string, value: unknown): Promise<void> {
  const existing = await db
    .select({ key: systemSettings.key })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1)
  if (existing.length > 0) {
    await db.update(systemSettings).set({ value: value as Record<string, unknown> }).where(eq(systemSettings.key, key))
  } else {
    await db.insert(systemSettings).values({ key, value: value as Record<string, unknown> })
  }
}

export async function loadAuthPolicy(): Promise<AuthPolicy> {
  const value = await readKey<Partial<AuthPolicy>>(KEY)
  cached = {
    requirePrecreatedUser:
      typeof value?.requirePrecreatedUser === 'boolean' ? value.requirePrecreatedUser : DEFAULT_POLICY.requirePrecreatedUser,
  }
  const groupValue = await readKey<Partial<OktaGroupSettings>>(GROUP_SETTINGS_KEY)
  cachedGroups = {
    groupClaimName: groupValue?.groupClaimName ?? DEFAULT_GROUP_SETTINGS.groupClaimName,
    defaultRole:
      groupValue?.defaultRole === 'leader' || groupValue?.defaultRole === 'team_admin'
        ? groupValue.defaultRole
        : DEFAULT_GROUP_SETTINGS.defaultRole,
    defaultTeamId: groupValue?.defaultTeamId ?? DEFAULT_GROUP_SETTINGS.defaultTeamId,
    requestGroupsScope:
      typeof groupValue?.requestGroupsScope === 'boolean'
        ? groupValue.requestGroupsScope
        : DEFAULT_GROUP_SETTINGS.requestGroupsScope,
  }
  return cached
}

export function getAuthPolicy(): AuthPolicy {
  return cached ?? DEFAULT_POLICY
}

export function getOktaGroupSettings(): OktaGroupSettings {
  return cachedGroups ?? DEFAULT_GROUP_SETTINGS
}

export async function saveAuthPolicy(policy: AuthPolicy): Promise<void> {
  await upsert(KEY, policy)
  cached = policy
}

export async function saveOktaGroupSettings(settings: OktaGroupSettings): Promise<void> {
  await upsert(GROUP_SETTINGS_KEY, settings)
  cachedGroups = settings
}
