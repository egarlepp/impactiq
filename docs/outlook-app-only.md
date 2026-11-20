# Outlook / Microsoft Graph — Application-only (App-Only) Access

ImpactIQ's default calendar integration uses **delegated** Graph access:
each user signs in to Microsoft with their own account, and ImpactIQ
reads *their own* calendar with a token scoped to that user. This works
for the "log my own activities" workflow — every contributor sees the
Outlook calendar column for their own week.

Admins and team admins can also open ImpactIQ's **person switcher**
in the Outlook calendar column header and look at a different
contributor's week. Their **activities** on the left panel come
straight from the ImpactIQ database and always show. But their
**actual Outlook calendar** cannot be read with a delegated token —
that requires **application-level** Graph access, configured on the
same Azure AD app registration ImpactIQ already uses.

When app-only Graph is *not* configured, the person switcher still
works — it just shows an inline banner in the calendar column
explaining the fallback, and the calendar column stays empty for
the other person.

## Why app-only?

Graph exposes two authorization modes:

| Mode         | Token scope                             | Can read      |
| ------------ | --------------------------------------- | ------------- |
| Delegated    | The signed-in user                      | Only that user |
| Application  | The tenant, subject to app permissions  | Any mailbox   |

Team admins reviewing a report or spotting workload issues need
"any mailbox" behavior — hence the application flow.

## What ImpactIQ does when it's on

For any person-switcher lookup where the caller is authorized (app
admin, or team admin/admin on a shared team), ImpactIQ fetches a
client-credentials token from Microsoft using the same
`clientId` / `clientSecret` / `tenantId` you already provided for
delegated Graph, and calls
`GET https://graph.microsoft.com/v1.0/users/{upn}/calendarView` with
that token. The target user is identified by their email
(userPrincipalName) as stored in ImpactIQ.

Nothing in ImpactIQ writes to another user's mailbox — app-only
access is used **read-only** and only for calendar data.

## Enabling app-only Graph

1. **Azure Portal → Microsoft Entra ID → App registrations →** the
   registration you already use for ImpactIQ (or create one).
2. **API permissions →** Add a permission → Microsoft Graph →
   **Application permissions** → select **`Calendars.Read`**.
3. Click **Grant admin consent** for your tenant. This is required
   — without admin consent the client-credentials token request
   will fail with `AADSTS65001`.
4. **Certificates & secrets →** Create a new client secret (or reuse
   the one already in ImpactIQ). Copy the *value* (not the secret
   ID) — you'll paste it in step 6.
5. **Admin → Integrations → Microsoft Graph** in ImpactIQ. Verify
   `Application (Client) ID` and `Tenant ID` match the Entra
   registration. Paste the client secret if you rotated it.
6. Tick **"Enable application-level (any-mailbox) calendar access"**
   and click **Save**.

That's it — the person switcher will now show real Outlook events
for other users, subject to the tenant's own privacy/DLP policies.

## Testing

- Open **Activities**. In the Outlook calendar column header, click
  your own name.
- Pick another team member (as an admin or team admin).
- If app-only is off → you'll see an amber banner:
  *"Real Outlook calendar for {name} requires app-only Graph.
  Only their ImpactIQ activities are shown."*
- If app-only is on → the calendar column populates with their
  Outlook events. Events linked to logged activities are tinted with
  the activity type's color; unlinked events stay grey.

## Privacy note

Application-level Graph permissions grant **tenant-wide** calendar
read to the app registration. Only enable this if your
Security team is OK with it. Application Access Policies can be
used to scope the app to a subset of mailboxes if a tenant-wide
policy is too broad — see Microsoft's
[Application access policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
documentation.

Client secrets rotate — set a calendar reminder for whichever
expiration you picked when creating the secret. When it expires,
ImpactIQ's person switcher will silently fall back to the "activities
only" banner until the secret is refreshed.
