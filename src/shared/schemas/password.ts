// Password complexity policy — shared between client (form hints + pre-flight
// validation) and server (authoritative enforcement on user create / change).
//
// Min 8 chars, at least one uppercase, lowercase, number, and special character.

export const PASSWORD_MIN_LENGTH = 10

export const PASSWORD_RULES = [
  { key: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p: string) => p.length >= PASSWORD_MIN_LENGTH },
  { key: 'upper', label: 'One uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { key: 'lower', label: 'One lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { key: 'number', label: 'One number', test: (p: string) => /[0-9]/.test(p) },
  { key: 'special', label: 'One special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const

export function validatePasswordComplexity(password: string): { ok: boolean; failedLabels: string[] } {
  const failed = PASSWORD_RULES.filter((r) => !r.test(password))
  return { ok: failed.length === 0, failedLabels: failed.map((f) => f.label) }
}

// Password reuse + expiry policy — scoped to accounts whose ONLY sign-in
// method is a local ImpactIQ password (authMethod === 'password'). Okta and
// Azure/Entra SSO accounts manage their own credential lifecycle at the IdP
// and are entirely exempt, including an account whose authMethod is 'both'
// (all login options) since password is then only one of several ways in —
// see CLAUDE.md §4/§5 for the full write-up.
export const PASSWORD_HISTORY_LIMIT = 5
export const PASSWORD_EXPIRY_DAYS = 90

export type AuthMethod = 'password' | 'okta' | 'azure' | 'both'

// Whether this account's authMethod includes local password login at all —
// gates the reuse/expiry policy, and the client's "password required" form
// validation.
export function authMethodNeedsPassword(authMethod: string): boolean {
  return authMethod !== 'okta' && authMethod !== 'azure'
}

// Whether this account's authMethod allows Okta SSO login specifically —
// 'password' and 'azure' are each an exclusive choice, so both exclude it.
export function authMethodAllowsOkta(authMethod: string): boolean {
  return authMethod !== 'password' && authMethod !== 'azure'
}

// Whether this account's authMethod allows Azure/Entra SSO login
// specifically — 'password' and 'okta' are each an exclusive choice, so
// both exclude it.
export function authMethodAllowsAzure(authMethod: string): boolean {
  return authMethod !== 'password' && authMethod !== 'okta'
}
