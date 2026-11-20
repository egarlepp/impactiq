// Why an Okta or Azure sign-in was refused. The OIDC callbacks redirect to
// `/?oktaConnect=error&reason=<key>` (or `ssoConnect` for Azure), and the
// Login page shows the matching `errors.auth.*` string. The page only shows
// keys from this list, so a crafted link can't put its own text on the
// sign-in screen.
export const SSO_ERROR_REASONS = [
  'errors.auth.account_disabled',
  'errors.auth.sso_failed',
  'errors.auth.sso_denied',
  'errors.auth.sso_no_email',
  'errors.auth.sso_email_mismatch',
  'errors.auth.sso_email_unverified',
  'errors.auth.sso_method_not_allowed',
  'errors.auth.sso_no_account',
] as const

export type SsoErrorReason = (typeof SSO_ERROR_REASONS)[number]

export function isSsoErrorReason(value: unknown): value is SsoErrorReason {
  return typeof value === 'string' && (SSO_ERROR_REASONS as readonly string[]).includes(value)
}

// Maps the `error` an identity provider sends back (OAuth 2.0 error codes
// such as `access_denied`) to a reason. Anything else reads as a failed sign-in.
export function ssoErrorReason(idpError: string): SsoErrorReason {
  return idpError === 'access_denied' ? 'errors.auth.sso_denied' : 'errors.auth.sso_failed'
}
