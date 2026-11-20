# Okta SSO Setup for ImpactIQ

This document captures the full Okta configuration required to enable "Sign in with Okta" for ImpactIQ. It exists because several of these gates are easy to miss and produce identical "not allowed to access this app" errors when missing.

## 1. Create the OIDC application in Okta

Okta Admin → **Applications → Applications → Create App Integration**.

- Sign-in method: **OIDC - OpenID Connect**
- Application type: **Web Application**
- Name: `ImpactIQ`
- Grant type: **Authorization Code** (and **Refresh Token** if you want sessions to survive Okta token expiry without re-prompting)
- **Sign-in redirect URI**: `https://<your-impactiq-host>/auth/callback`
  - This must be the exact path. ImpactIQ's Express server only has one OIDC callback route, and it's `/auth/callback`. Okta's auto-suggested `/authorization-code/callback` is just a placeholder from their SDK samples — it does **not** work with ImpactIQ.
- **Sign-out redirect URI**: optional
- Assignments: choose who can use it (a group like `ImpactIQ Users`, or assign individuals)

After creation, copy the **Client ID** and **Client Secret**.

## 2. Configure ImpactIQ

App → **Admin → Integrations → Okta**:

- **Domain**: `<your-org>.okta.com` (no scheme, no path)
- **Client ID**: from step 1
- **Client Secret**: from step 1
- **Redirect URI**: must exactly match what you entered in Okta (`https://<your-impactiq-host>/auth/callback`)

Click **Test Connection** to verify ImpactIQ can reach the Okta token endpoint. A green check confirms the credentials and OIDC discovery work; it does **not** validate the access policies covered below.

## 3. The four gates Okta enforces (in order)

A sign-in request hits each of these in sequence. If any one fails, you see a generic "not allowed" message — Okta does not tell you which gate said no.

### Gate 1 — App is Active and user is assigned
- Applications → ImpactIQ → top-right status: **Active**
- Applications → ImpactIQ → **Assignments** tab: user is listed (individually or via a group)

### Gate 2 — App Authentication Policy
- Applications → ImpactIQ → **Sign On** tab → **User authentication** → policy must have at least one rule allowing your user with a satisfiable factor (Password is enough)
- A fresh policy with no rules denies everyone

### Gate 3 — Global Session Policy
- Security → **Global Session Policy** → at least one rule must match your user/network and allow establishing a session

### Gate 4 — Authorization Server Access Policy ⚠️ easy to miss
- Security → **API** → **Authorization Servers** → **default** → **Access Policies** tab
- A brand-new Okta org has **no access policies on the default authorization server**. With no policies, every `/oauth2/default/v1/authorize` request is rejected before any app-level policy runs.
- This is the most common cause of the "not allowed" wall when everything else looks correct.

**To add it:**

1. Click **Add Policy**
2. Name: `Default Policy`
3. Assign to: **All clients** (or pick ImpactIQ explicitly)
4. Create Policy
5. **Add Rule** inside that policy:
   - Rule name: `Default Rule`
   - IF Grant type is: **Authorization Code** (+ **Refresh Token** if applicable)
   - User: **Any user assigned the app**
   - Scopes requested: **Any scopes** (or explicitly `openid`, `profile`, `email`)
   - Leave token lifetimes at defaults
   - Create Rule

After adding this, retry sign-in in a fresh incognito window.

## 4. OIDC discovery

ImpactIQ uses OIDC discovery to find Okta's authorization, token, and userinfo endpoints. It tries `https://<domain>/oauth2/default/.well-known/openid-configuration` first (matches the `/oauth2/default/` paths used by dev/Integrator orgs), and falls back to `https://<domain>/.well-known/openid-configuration` for orgs that use the org-level authorization server. Results are cached per host for 1 hour. No additional config required.

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 404 on "Sign in with Okta" | OIDC discovery failed — confirm `Domain` field has no scheme/path |
| Okta 400 "redirect_uri must be a Login redirect URI" | Sign-in redirect URI in Okta doesn't match the value in ImpactIQ → both must be `/auth/callback` |
| "You are not allowed to access this app" with URL still on `/authorize` | Gate 4 — no access policy on the default authorization server |
| "You are not allowed" *after* entering password | Gate 2 (app policy) or Gate 3 (global session policy) has no matching rule |
| Lands on `/auth/callback?code=…` then errors | Server-side — check ImpactIQ logs; usually email JIT-provisioning or session cookie issue |

## 6. System Log is the source of truth

Reports → **System Log** → filter to the last few minutes → find the failed event → expand **Reason** and **DebugContext.debugData**. This names the exact gate that denied the request and is faster than guessing through screens.
