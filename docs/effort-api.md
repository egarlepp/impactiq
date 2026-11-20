# Effort API (v1.448+)

Read-only hour totals for one CRM Opportunity. CriteriaIQ reads it to show the SE effort logged in ImpactIQ on a
project page. Other tools may use it the same way.

## Key

Create the key in **My Settings → API Keys** with only the `effort:read` scope. Only a Team Leader, team admin or
App Admin can create one. The key:

- reaches `GET /api/v1/effort` and nothing else (`/api/*` refuses it because it lacks `rest:full`, and `/api/mcp`
  refuses it because it lacks `mcp:read`)
- acts with its owner's current access. On every call the owner must still be active, must not have a pending
  password change, and must still be a Team Leader or admin somewhere. Only the teams the owner can see now are counted.
- is limited per key per minute and per hour (the same limits as MCP keys)

Revoke it in the same place. Disabling the owner also revokes it.

## Request

```
GET /api/v1/effort?crmOpportunityId=006Ab00000XyZ12AAB
Authorization: Bearer iqk_...
```

`crmOpportunityId` is a Salesforce Opportunity id (15 or 18 characters) or a HubSpot Deal id. A Salesforce id matches
activities saved with either length.

## Response

```json
{
  "data": {
    "version": 1,
    "crmOpportunityId": "006Ab00000XyZ12AAB",
    "totalHours": 6.75,
    "activityCount": 3,
    "firstActivityAt": "2026-10-18T15:00:00.000Z",
    "lastActivityAt": "2026-10-22T15:00:00.000Z",
    "byPerson": [{ "name": "Ana SE", "email": "ana@example.com", "hours": 5.5, "activityCount": 2 }],
    "byType": [{ "name": "POx Work", "hours": 3.5, "activityCount": 1 }],
    "cost": { "currency": "USD", "totalCost": 725, "laborCost": 675, "directCost": 50, "activitiesWithoutRate": 0 }
  },
  "error": null,
  "meta": {}
}
```

- Counts submitted, unarchived activities whose primary record is that Opportunity. Drafts are never counted, and
  neither are activities linked only to the Account.
- An Opportunity with nothing logged gets zeros and empty lists, not a 404, so the response doesn't show whether an id
  exists.
- Totals only. No titles, notes, meeting details or activity ids are returned, so a private meeting's subject cannot
  leave through this API.
- Emails are lower-cased, so a caller can match people by email.
- `cost` (v1.449+) is one total for the Opportunity, in USD: labor (each activity's hours × its owner's cost rate for
  that team and day, from a cost group or a personal override, as on the cost dashboards) plus direct costs (travel,
  lodging, food). `activitiesWithoutRate` counts activities whose owner had no cost rate; their hours add no labor
  cost. Cost is never broken down by person or activity type, because a per-person figure divided by its hours would
  give that person's rate. A caller should still decide who may see the total.
- `Cache-Control: private, no-store`.

| Status | Meaning |
|---|---|
| 400 | Missing or malformed `crmOpportunityId` |
| 401 | No key, or an invalid, expired or revoked key |
| 403 | The key lacks `effort:read`, or its owner no longer leads a team |
| 428 | The owner must change their password first |
| 429 | Per-key limit reached (`Retry-After`) |

## Linking to the activities

`<ImpactIQ address>/?openOpportunity=<crmOpportunityId>&name=<label>` (v1.449+) opens the activities drawer for that Opportunity on their active team. `name` is only the drawer's heading. What the
drawer lists follows the person's own ImpactIQ access, not the key's. A password sign-in keeps the link; an Okta or
Azure sign-in returns to the home page, so the person clicks the link again.

## Activity types (v1.454+)

```
GET /api/v1/effort/activity-types
Authorization: Bearer iqk_...
```

The active activity type names on the key owner's teams, one row per name (teams each have their own copy of a type),
sorted by name. CriteriaIQ's admin picks from this list which types count toward a project.

```json
{ "data": { "version": 1, "activityTypes": [{ "name": "POx Work", "hasProjectPicker": true }, { "name": "Demo", "hasProjectPicker": false }] } }
```

`hasProjectPicker` is true when the type has a related record (Project) picker on at least one of those teams. Only
those types carry a Project link, so a chosen type without one counts only through the Opportunity fallback below.

## Project activity counts (v1.454+)

```
POST /api/v1/effort/project-counts
Authorization: Bearer iqk_...
Content-Type: application/json

{
  "activityTypes": ["POx Work", "Demo"],
  "opportunityFallback": false,
  "projects": [
    { "criteriaiqProjectId": 12, "crmProjectId": "a0X5e00000AbCdEFGH", "crmOpportunityId": "006Ab00000XyZ12AAB",
      "startDate": "2026-10-01", "endDate": "2026-11-30" }
  ]
}
```

Read-only; it is a POST only because 200 projects don't fit in a URL. Up to 200 projects and 50 type names per call.
Only `criteriaiqProjectId` is required. The answer has one row per project, in the order sent:

```json
{ "data": { "version": 1, "projects": [
  { "criteriaiqProjectId": 12, "activityCount": 4, "totalHours": 9.5, "lastActivityAt": "2026-10-25T15:00:00.000Z", "viaOpportunity": 1 }
] } }
```

An activity counts toward a project when it is submitted, unarchived, on one of the key owner's teams, its type name
is in `activityTypes` (case-insensitive), and it is linked to the project's record:

- its Project is the CriteriaIQ project itself (`crm_related_type` `CriteriaIQ`, id `criteriaiqProjectId`), or
- its Project is `crmProjectId` (the Salesforce Evaluation, matched on the 15-char id, or a HubSpot project object, matched exactly).

With `opportunityFallback: true`, an activity of a chosen type that has **no** Project link also counts when it is on
`crmOpportunityId` and its start date falls between `startDate` and `endDate` (both needed). Such an activity counts
on every project that shares that Opportunity and overlapping dates; `viaOpportunity` says how many came in that way.

Totals only, like `/effort`: no titles, notes, people or cost. A call counts against the key's rate limit as one call
per 50 projects. `400` (`errors.effort.invalid_project_counts`) for a malformed body; the key is checked first.

## Project activity list (v1.479+)

```
POST /api/v1/effort/project-activities
Authorization: Bearer iqk_...
Content-Type: application/json

{ "activityTypes": ["POx Work", "Demo"], "opportunityFallback": false,
  "project": { "criteriaiqProjectId": 12, "crmProjectId": "a0X5e00000AbCdEFGH", "crmOpportunityId": "006Ab00000XyZ12AAB",
               "startDate": "2026-10-01", "endDate": "2026-11-30" } }
```

The activities behind one project's count, for CriteriaIQ's Activities drawer. Same key, same rules and the same
matching code as `project-counts`, so the list always agrees with the count. Newest first, at most 500
(`truncated: true` when there are more; `activityCount` and `totalHours` still cover all of them):

```json
{ "data": { "version": 1, "criteriaiqProjectId": 12, "activityCount": 2, "totalHours": 3.5, "truncated": false,
  "activities": [
    { "id": "6f1c...", "type": "POx Work", "typeIcon": "FlaskConical", "typeColor": "#7C3AED", "ownerName": "Ana SE", "hours": 1.5,
      "startAt": "2026-10-25T15:00:00.000Z", "endAt": "2026-10-25T16:30:00.000Z", "viaOpportunity": false }
  ] } }
```

Each row carries the type with its icon (a lucide name) and color from Admin → Activity Types (both `null` when unset),
the person who logged it, hours and dates; never the title, notes or cost. One call against
the key's rate limit. `400` (`errors.effort.invalid_project_activities`) for a malformed body; the key is checked first.

## Versioning

Fields are only ever added to `version: 1`. A breaking change would ship as a new path next to this one.
