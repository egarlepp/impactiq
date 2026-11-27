// URLs on Microsoft's sign-in host for a tenant. The tenant comes from admin
// settings (or MS_TENANT_ID): a directory GUID, a verified domain such as
// contoso.onmicrosoft.com, or common / organizations / consumers. Anything else
// is refused, and the value is encoded as one path segment, so it can never
// change the host or the path after it.
const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com'
const TENANT_RX = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/

export function isValidMicrosoftTenant(tenantId: string): boolean {
  return TENANT_RX.test(tenantId) && !tenantId.includes('..')
}

export function microsoftLoginUrl(tenantId: string, path: '/oauth2/v2.0/token' | '/oauth2/v2.0/authorize' | '/v2.0/.well-known/openid-configuration'): string {
  const tenant = tenantId.trim()
  if (!isValidMicrosoftTenant(tenant)) throw new Error('Microsoft tenant id is not valid')
  return `${MICROSOFT_LOGIN_ORIGIN}/${encodeURIComponent(tenant)}${path}`
}
