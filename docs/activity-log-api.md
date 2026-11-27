# Activity Log API (v1.481+)

Lets another tool log an activity for an ImpactIQ user it names by email. DemoIQ uses it to log each finished demo.
The activity always arrives as a **draft** on that person's own Activities list, like a suggested meeting. They check
it, link the CRM record and approve it; only then does the normal CRM write-back run. Nothing goes to the CRM before
that.

## Key

An App Admin creates the key in **My Settings → API Keys** with only the `activities:log` scope. Only App Admins see
that scope, and the server refuses it for anyone else. The key:

- reaches `POST /api/v1/activities/log` and `GET /api/v1/activities/subtypes` and nothing else (`/api/*` refuses it because it lacks `rest:full`, `/api/mcp`
  because it lacks `mcp:read`)
- needs its owner to still be an active App Admin with no pending password change on every call, not only when it was
  made. Disabling or demoting the owner stops it.
- is limited per key per minute and per hour (the same limits as MCP and effort keys), and each address to 120
  calls a minute before the key is checked

Every activity it creates is in the Audit Log as `activity.log_via_api`, with the key owner as the actor.

## Request

```
POST /api/v1/activities/log
Authorization: Bearer iqk_...
Content-Type: application/json

{
  "ownerEmail": "ana@example.com",
  "activityType": "Demo",
  "title": "Demo: Threat Prevention for Acme",
  "startDatetime": "2026-11-20T15:00:00Z",
  "endDatetime": "2026-11-20T16:30:00Z",
  "effortHours": 1.5,
  "notes": "Showed lockdown policies. Next step: POC scoping call.",
  "locationMode": "remote",
  "attendees": [{ "name": "Pat Prospect", "email": "pat@acme.test" }],
  "externalRef": "demoiq:run:7f0c..."
}
```

| Field | |
|---|---|
| `ownerEmail` | The person the activity belongs to, matched in any case. |
| `activityType` | An active activity type on that person's team, by name in any case (a type shared with the team counts). Default `Demo`. |
| `subtype` | Optional (v1.482+). A Subtype of that type, by name in any case. Ignored when the team has Subtypes off or none has that name; the response's `subtype` says what was stored. |
| `title` | Up to 500 characters. |
| `startDatetime`, `endDatetime` | ISO 8601 with a zone. The end must be after the start and within 24 hours. |
| `effortHours` | Optional, 0–24. Defaults to the time between start and end. |
| `notes` | Optional, up to 5,000 characters. Write-back sends it to the CRM like any notes once the person approves. |
| `locationMode` | Optional, `remote` (default) or `onsite`. |
| `attendees` | Optional, up to 500 `{ name, email }`. |
| `externalRef` | Required. The caller's own id for this activity, up to 200 characters of letters, digits and `. _ : / -`. |

The team is the person's default team when they are a member of it, otherwise their first active team by name.

## Retries

`externalRef` is unique across ImpactIQ. Sending the same one again returns the activity the first call made, with
`200` and `deduped: true`, and changes nothing (the person may have edited or approved it since). The same
`externalRef` for a different person is `409`.

## Response

`201` when created, `200` for a retry:

```json
{
  "data": {
    "version": 1,
    "activityId": "8a1e...",
    "status": "draft",
    "deduped": false,
    "ownerEmail": "ana@example.com",
    "teamId": "c7d2...",
    "teamName": "Sales Engineering",
    "activityType": "Demo",
    "subtype": "Technical Demo",
    "startDatetime": "2026-11-20T15:00:00.000Z",
    "url": "https://impactiq.example.com/?openActivityId=8a1e...&startDate=2026-11-20"
  },
  "error": null,
  "meta": { "deduped": false }
}
```

`url` opens the activity in ImpactIQ (null when no public address is set). `status` is `submitted` on a retry after the
person approved it.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `errors.activity_log.invalid_request` | The body is wrong; `meta.issues` lists `{ path, message }` |
| 401 | `errors.apikey.missing` / `errors.apikey.invalid` | No key, or an invalid, expired or revoked key |
| 403 | `errors.apikey.wrong_scope` / `errors.forbidden` | The key lacks `activities:log`, or its owner is no longer an App Admin |
| 409 | `errors.activity_log.ref_in_use` | That `externalRef` belongs to another person's activity |
| 422 | `errors.activity_log.user_not_found` | No user with that email |
| 422 | `errors.activity_log.user_disabled` | The user is disabled |
| 422 | `errors.activity_log.no_team` | The user belongs to no active team |
| 422 | `errors.activity_log.type_not_found` | No active type with that name on the user's team |
| 428 | `errors.must_change_password` | The key owner must change their password first |
| 429 | `errors.rate_limited` | Per-key limit reached (`Retry-After`) |

## Subtypes (v1.482+)

Lists the Subtypes a log call for this person and type would accept, so the caller can offer them first. DemoIQ uses it
for its demo types. Same key, checks and limits as the log endpoint; the team and type are picked the same way.

```
GET /api/v1/activities/subtypes?ownerEmail=ana@example.com&activityType=Demo
Authorization: Bearer iqk_...
```

```json
{
  "data": {
    "version": 1,
    "ownerEmail": "ana@example.com",
    "teamId": "c7d2...",
    "teamName": "Sales Engineering",
    "activityType": "Demo",
    "subtypesEnabled": true,
    "subtypes": [{ "id": "4b1f...", "name": "Executive Demo" }, { "id": "9e0a...", "name": "Technical Demo" }]
  },
  "error": null,
  "meta": {}
}
```

Subtypes come in the order set on Admin → Activity Types. `subtypesEnabled` is false and `subtypes` empty when the team
has Subtypes turned off. Errors are the log endpoint's: `400 invalid_request`, `401`/`403` for the key,
`422 user_not_found`, `user_disabled`, `no_team` or `type_not_found`, `429`.
