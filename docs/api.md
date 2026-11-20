# ImpactIQ API Reference

This document is the integration contract for external orchestration engines (n8n, Zapier, internal scripts, future automations) and any consumer that talks to ImpactIQ over HTTP.

The endpoint tables at the bottom of this file are **generated**: re-run `node scripts/gen-api-routes.mjs` after every route change and inline the output below the `## Endpoint inventory` heading.

---

## Auth model

Every API call is authenticated by a **session cookie** issued by one of:

- `POST /auth/login` — local password credentials.
- `GET /auth/callback` — Okta OIDC callback (sets the cookie after a successful federation flow).

Send the cookie on every `/api/*` call (`credentials: 'same-origin'` if you're using `fetch`). The cookie is HTTP-only, secure when served over HTTPS, and tied to a server-side JWT-style session payload.

There is **no API-key auth model today**. Orchestration tools that can't keep a cookie jar need to perform `POST /auth/login` first and re-use the `Set-Cookie` header.

### Role enforcement

Three trust tiers, checked server-side on every protected route:

| Tier | Middleware | Description |
|------|------------|-------------|
| Session | `requireAuth` | Any logged-in user. |
| Team role | `requireRole('leader' \| 'admin' \| ...)` | Membership in the targeted team with the named role. |
| App admin | `requireAppAdmin` | The `users.is_app_admin` flag — bypasses team scoping entirely. |

The client mirrors this in `src/client/hooks/useCurrentUser.ts` via the `permissions` map returned by `GET /auth/me`.

## Response envelope

**Every** endpoint returns:

```json
{ "data": <T> | null, "error": <string> | null, "meta": <object> }
```

- `data` carries the resource (or `null` on error).
- `error` is `null` on success, or an **i18n key** (`errors.team_id_required`, `errors.salesforce.not_connected`, …) the client will localize, or — for legacy routes still being migrated — a free-text English string.
- `meta` carries pagination, range echoes, or sync diagnostics. Always an object, never `null`.

### Error key format

Error keys live under the `errors.*` namespace in `src/client/i18n/locales/en/translation.json`. A consumer that wants its own localization layer can read the EN file directly. Errors with interpolation arrive as `errors.foo|key=value|other=value2` — split on `|`, the first segment is the key, the rest are interpolation params.

Common error keys:

| Key | Meaning |
|-----|---------|
| `errors.unauthorized` | Session missing or expired |
| `errors.forbidden` | Authenticated but lacks the required role |
| `errors.not_found` | Resource doesn't exist |
| `errors.validation.team_id_required` | `teamId` query param missing |
| `errors.validation.field_required` | A required body field is missing |
| `errors.database.insert_failed` | DB write returned no rows (rare) |

Full inventory in [`errors.*`](../src/client/i18n/locales/en/translation.json).

## Conventions

- **UUIDs everywhere** for resource IDs. Activity IDs, user IDs, team IDs all v4 UUIDs.
- **ISO 8601** timestamps with `Z` suffix. Activity `startDatetime`, `endDatetime`, all `createdAt` / `updatedAt`.
- **`teamId` accepts the literal `'all'`** on dashboard endpoints when the caller has `canSeeAllTeams=true` — the server unions across every accessible team.
- **Soft delete via `is_archived`** on `activities`. There is no DELETE; clients call `PATCH /api/activities/:id` with `{ isArchived: true }` to retire a record.
- **No rate limits today.** Self-throttle to ≤ 5 req/sec per consumer. Aggressive batches against `/api/admin/*` can starve the request loop.

## Orchestration-friendly endpoints

These six are the safe surface for automation — idempotent inputs, structured outputs, no UI side effects:

### `POST /api/activities` — log a new activity

Request body:

```json
{
  "teamId": "uuid",
  "title": "string (≤ 200 chars)",
  "activityTypeId": "uuid",
  "status": "draft | submitted",
  "startDatetime": "2026-06-30T13:00:00Z",
  "endDatetime":   "2026-06-30T14:00:00Z",
  "effortHours": 1.0,
  "notes": "optional string",
  "outlookEventId": "optional — used for de-duplication when present",
  "crmWhatId": "optional — Salesforce Opportunity or Account Id",
  "crmWhatType": "Opportunity | Account",
  "crmWhatName": "optional display name"
}
```

Response: `{ data: { id, status, crmSyncStatus, createdAt }, error: null, meta: {} }`. The activity is queued for async Salesforce write-back if `status === 'submitted'` and `crmWhatId` is set; poll the same record's `crmSyncStatus` to track that. The endpoint is idempotent on `outlookEventId` — same Outlook event will not double-log.

### `GET /api/dashboards/*` — read-only analytics

30+ read-only dashboards today (CLAUDE.md §13 has the full, current list by group — Capacity/Activity/Accounts/Health/Products/Revenue/Manager/Infrastructure/Coverage/History — new ones ship often, so treat any count here as a snapshot). Each accepts `?teamId=<uuid>|all&weeks=<integer>` and returns aggregated rows. No mutation, safe to poll. A representative sample (see the `dashboards.ts` table in the generated inventory below for the complete, always-current list of every route):

- `heatmap` — contributor × week effort matrix with capacity color buckets.
- `breakdown` — effort hours per activity type, optionally filtered by `userId`.
- `burn` — Account/Opportunity time concentration ranking.
- `capacity-trend` — team total vs capacity per week.
- `this-week-capacity` — current-week per-contributor bar chart.
- `plan-vs-actual` — logged vs (count × typical-duration) per type.
- `compliance` — % of contributors logging weekly + non-loggers.
- `lag` — average days between activity end and creation.
- `mix` — per-contributor activity type mix.
- `concentration` — distribution across SF Accounts/Opps.
- `wow` — week-over-week delta.

### `GET /api/teams` — list accessible teams

Returns every team the requesting user is a member of, plus `canSeeAllTeams` if the user has the flag. Use this to discover valid `teamId` values before calling scoped endpoints.

### CRM search: `/api/salesforce/search/*` or `/api/crm/search/*`

The install runs one CRM (Salesforce, HubSpot, or none; see `docs/crm.md`). Call `GET /api/crm/provider` first to learn which.

- **Salesforce**: `GET /api/salesforce/search/opportunities` and `/accounts` (also `/contacts`, `/leads`, `/campaigns`). Pass `?q=<term>`. Returns up to 20 SF records. Filtered server-side by the contributor's SF user id when the **Open Search** toggle is off (the default). The whole `/api/salesforce/*` router answers 409 `errors.crm.provider_mismatch` when Salesforce isn't the active CRM.
- **HubSpot** (and any future CRM): the CRM-neutral `GET /api/crm/search/{opportunities,accounts,contacts,leads,campaigns}`, plus `/api/crm/preview/:type/:id`, tickets, Projects, Assigned SE and attendee routes. Results keep ImpactIQ's field names (a Deal comes back as an Opportunity, a Company as an Account). 401 `errors.crm.not_connected` when the CRM connection is missing; Leads and Campaigns answer 403 when switched off or not offered by the portal.

### `POST /api/ai/classify` — single-call activity type suggestion

Request: `{ teamId, subject, body? }`. Returns `{ activityTypeId, activityTypeName, confidence, source: 'keyword' | 'ai' | 'none' }`. Stateless — safe to call from automations that want to pre-label an incoming meeting.

### `GET /api/notifications` — list current in-app notifications

Returns up to 50 most recent notifications for the calling user across all their teams. Use `?since=<iso>` to poll for new ones.

## OAuth callbacks are NOT integration points

`/auth/okta`, `/auth/salesforce`, `/auth/microsoft`, `/auth/callback`, `/auth/salesforce/callback`, `/auth/microsoft/callback` exist for **interactive** sign-in / authorization only. They set session cookies, redirect to `/`, and consume one-time HMAC state tokens. Do not call them from server-side code.

## Versioning

The API is **unversioned**. Breaking changes will be communicated via the CHANGELOG in the repo and called out in the PR description that introduces them. Consumers should pin to a known-good commit if stability matters.

## Endpoint inventory

> The tables below are auto-generated from `src/server/routes/*.ts`. Re-run `node scripts/gen-api-routes.mjs` after route changes.

<!-- BEGIN AUTOGEN -->

Total endpoints: **518**. Source: `node scripts/gen-api-routes.mjs`.

## `activities.ts` (17 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/activities` | session |
| POST | `/api/activities` | session |
| GET | `/api/activities/:id` | session |
| PATCH | `/api/activities/:id` | session |
| DELETE | `/api/activities/:id` | session |
| POST | `/api/activities/:id/resync` | session |
| GET | `/api/activities/:id/sync-audit` | session |
| GET | `/api/activities/account-drill` | session |
| GET | `/api/activities/by-sf` | session |
| GET | `/api/activities/eval-fields` | session |
| POST | `/api/activities/import` | session |
| GET | `/api/activities/month-heatmap` | session |
| GET | `/api/activities/outlook-deleted` | session |
| DELETE | `/api/activities/outlook-deleted` | session |
| POST | `/api/activities/outlook-deleted/keep` | session |
| POST | `/api/activities/relink-opportunity` | role: 'leader', 'admin' |
| GET | `/api/activities/sf-extras/:typeId` | session |

## `admin.ts` (261 endpoints)

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/admin/activities/:id/retry-sync` | app-admin |
| POST | `/api/admin/activities/import` | session |
| POST | `/api/admin/activities/retry-sync-batch` | app-admin |
| GET | `/api/admin/activity-health` | app-admin |
| PATCH | `/api/admin/activity-health/:id` | app-admin |
| GET | `/api/admin/activity-templates` | app-admin |
| POST | `/api/admin/activity-templates` | app-admin |
| DELETE | `/api/admin/activity-templates/:id` | app-admin |
| PATCH | `/api/admin/activity-templates/:id` | app-admin |
| POST | `/api/admin/activity-templates/:id/clone` | app-admin |
| GET | `/api/admin/activity-types` | app-admin |
| POST | `/api/admin/activity-types` | app-admin |
| PATCH | `/api/admin/activity-types/:typeId` | app-admin |
| DELETE | `/api/admin/activity-types/:typeId` | app-admin |
| GET | `/api/admin/audit` | app-admin |
| GET | `/api/admin/audit/summary` | app-admin |
| GET | `/api/admin/auth-policy` | app-admin |
| PUT | `/api/admin/auth-policy` | app-admin |
| GET | `/api/admin/capacity-groups` | app-admin |
| POST | `/api/admin/capacity-groups` | app-admin |
| PATCH | `/api/admin/capacity-groups/:groupId` | app-admin |
| DELETE | `/api/admin/capacity-groups/:groupId` | app-admin |
| POST | `/api/admin/capacity-groups/:groupId/teams/:teamId` | app-admin |
| DELETE | `/api/admin/capacity-groups/:groupId/teams/:teamId` | app-admin |
| GET | `/api/admin/capacity-user-overrides` | app-admin |
| POST | `/api/admin/capacity-user-overrides` | app-admin |
| PATCH | `/api/admin/capacity-user-overrides/:id` | app-admin |
| DELETE | `/api/admin/capacity-user-overrides/:id` | app-admin |
| GET | `/api/admin/capacity/effective` | app-admin |
| GET | `/api/admin/cost-groups` | app-admin |
| POST | `/api/admin/cost-groups` | app-admin |
| PATCH | `/api/admin/cost-groups/:groupId` | app-admin |
| DELETE | `/api/admin/cost-groups/:groupId` | app-admin |
| POST | `/api/admin/cost-groups/:groupId/teams/:teamId` | app-admin |
| DELETE | `/api/admin/cost-groups/:groupId/teams/:teamId` | app-admin |
| GET | `/api/admin/cost-user-overrides` | app-admin |
| POST | `/api/admin/cost-user-overrides` | app-admin |
| PATCH | `/api/admin/cost-user-overrides/:id` | app-admin |
| DELETE | `/api/admin/cost-user-overrides/:id` | app-admin |
| GET | `/api/admin/cost/effective` | app-admin |
| GET | `/api/admin/db-health` | app-admin |
| DELETE | `/api/admin/demo-data` | app-admin |
| POST | `/api/admin/demo-data/generate` | app-admin |
| GET | `/api/admin/demo-data/status` | app-admin |
| GET | `/api/admin/email-rules` | app-admin |
| PATCH | `/api/admin/email-rules/:key` | app-admin |
| POST | `/api/admin/email-rules/:key/preview` | app-admin |
| POST | `/api/admin/email-rules/:key/send-test` | app-admin |
| GET | `/api/admin/fiscal-year` | session |
| PATCH | `/api/admin/fiscal-year` | app-admin |
| GET | `/api/admin/fx-rates` | app-admin |
| POST | `/api/admin/fx-rates/refresh` | app-admin |
| POST | `/api/admin/historical-import/exclusions` | app-admin |
| PATCH | `/api/admin/historical-import/exclusions/:kind/:crmUserId` | app-admin |
| DELETE | `/api/admin/historical-import/exclusions/:kind/:crmUserId` | app-admin |
| GET | `/api/admin/historical-import/exclusions/:kind/:crmUserId/preview` | app-admin |
| POST | `/api/admin/historical-import/exclusions/:kind/:crmUserId/purge` | app-admin |
| POST | `/api/admin/historical-import/pause` | app-admin |
| POST | `/api/admin/historical-import/relink` | app-admin |
| POST | `/api/admin/historical-import/reset` | app-admin |
| POST | `/api/admin/historical-import/resume` | app-admin |
| PUT | `/api/admin/historical-import/settings` | app-admin |
| POST | `/api/admin/historical-import/start` | app-admin |
| GET | `/api/admin/historical-import/status` | app-admin |
| POST | `/api/admin/holiday-calendars` | app-admin |
| GET | `/api/admin/holiday-calendars` | app-admin |
| DELETE | `/api/admin/holiday-calendars/:id` | app-admin |
| GET | `/api/admin/holiday-calendars/:id/dates` | app-admin |
| POST | `/api/admin/holiday-calendars/:id/dates` | app-admin |
| DELETE | `/api/admin/holiday-calendars/:id/dates/:dateId` | app-admin |
| POST | `/api/admin/holiday-calendars/:id/refresh` | app-admin |
| GET | `/api/admin/holiday-calendars/assignments` | app-admin |
| PUT | `/api/admin/holiday-calendars/assignments/:userId` | app-admin |
| POST | `/api/admin/holiday-calendars/refresh` | app-admin |
| GET | `/api/admin/hubspot/project-objects` | session |
| GET | `/api/admin/hubspot/properties` | app-admin |
| GET | `/api/admin/integrations/config` | app-admin |
| PUT | `/api/admin/integrations/config/azure_sso` | app-admin |
| DELETE | `/api/admin/integrations/config/azure_sso` | app-admin |
| PUT | `/api/admin/integrations/config/microsoft` | app-admin |
| DELETE | `/api/admin/integrations/config/microsoft` | app-admin |
| PUT | `/api/admin/integrations/config/okta` | app-admin |
| DELETE | `/api/admin/integrations/config/okta` | app-admin |
| PUT | `/api/admin/integrations/config/salesforce` | app-admin |
| DELETE | `/api/admin/integrations/config/salesforce` | app-admin |
| PUT | `/api/admin/integrations/config/smtp` | app-admin |
| DELETE | `/api/admin/integrations/config/smtp` | app-admin |
| GET | `/api/admin/integrations/criteriaiq` | app-admin |
| PUT | `/api/admin/integrations/criteriaiq` | app-admin |
| DELETE | `/api/admin/integrations/criteriaiq` | app-admin |
| GET | `/api/admin/integrations/criteriaiq/lookup` | app-admin |
| POST | `/api/admin/integrations/criteriaiq/test` | app-admin |
| GET | `/api/admin/integrations/crm-features` | app-admin |
| PUT | `/api/admin/integrations/crm-features` | app-admin |
| GET | `/api/admin/integrations/crm-provider` | app-admin |
| PUT | `/api/admin/integrations/crm-provider` | app-admin |
| POST | `/api/admin/integrations/email/send-test` | app-admin |
| GET | `/api/admin/integrations/evaluation-source` | app-admin |
| PUT | `/api/admin/integrations/evaluation-source` | app-admin |
| GET | `/api/admin/integrations/hubspot` | app-admin |
| PUT | `/api/admin/integrations/hubspot` | app-admin |
| DELETE | `/api/admin/integrations/hubspot` | app-admin |
| POST | `/api/admin/integrations/hubspot/sync-owners` | app-admin |
| POST | `/api/admin/integrations/hubspot/test` | app-admin |
| GET | `/api/admin/integrations/login-logo` | app-admin |
| PUT | `/api/admin/integrations/login-logo` | app-admin |
| GET | `/api/admin/integrations/okta-allow-unverified-email` | app-admin |
| PUT | `/api/admin/integrations/okta-allow-unverified-email` | app-admin |
| GET | `/api/admin/integrations/outlook-app-only` | app-admin |
| PUT | `/api/admin/integrations/outlook-app-only` | app-admin |
| GET | `/api/admin/integrations/outlook-sync` | app-admin |
| PUT | `/api/admin/integrations/outlook-sync` | app-admin |
| GET | `/api/admin/integrations/public-base-url` | app-admin |
| PUT | `/api/admin/integrations/public-base-url` | app-admin |
| GET | `/api/admin/integrations/sf-internal-domains` | app-admin |
| PUT | `/api/admin/integrations/sf-internal-domains` | app-admin |
| GET | `/api/admin/integrations/slack` | app-admin |
| PUT | `/api/admin/integrations/slack` | app-admin |
| DELETE | `/api/admin/integrations/slack` | app-admin |
| POST | `/api/admin/integrations/slack/sync-users` | app-admin |
| GET | `/api/admin/integrations/status` | app-admin |
| GET | `/api/admin/integrations/support-email` | app-admin |
| PUT | `/api/admin/integrations/support-email` | app-admin |
| POST | `/api/admin/integrations/test/admin-salesforce` | app-admin |
| POST | `/api/admin/integrations/test/microsoft` | app-admin |
| POST | `/api/admin/integrations/test/okta` | app-admin |
| POST | `/api/admin/integrations/test/salesforce` | app-admin |
| POST | `/api/admin/integrations/test/smtp` | app-admin |
| GET | `/api/admin/login-history` | app-admin |
| GET | `/api/admin/maintenance-window` | session |
| PUT | `/api/admin/maintenance-window` | session |
| DELETE | `/api/admin/maintenance-window` | session |
| GET | `/api/admin/mcp-activity` | app-admin |
| GET | `/api/admin/mcp-config` | app-admin |
| PATCH | `/api/admin/mcp-config` | app-admin |
| POST | `/api/admin/note-pushes/:id/retry` | app-admin |
| GET | `/api/admin/nudge-history` | session |
| GET | `/api/admin/okta-group-mappings` | app-admin |
| PUT | `/api/admin/okta-group-mappings` | app-admin |
| GET | `/api/admin/products` | session |
| POST | `/api/admin/products` | app-admin |
| PATCH | `/api/admin/products/:id` | app-admin |
| DELETE | `/api/admin/products/:id` | app-admin |
| GET | `/api/admin/rate-limit` | app-admin |
| PUT | `/api/admin/rate-limit` | app-admin |
| GET | `/api/admin/role-permissions` | app-admin |
| PUT | `/api/admin/role-permissions` | app-admin |
| POST | `/api/admin/run-migrations` | app-admin |
| GET | `/api/admin/sales-team-alignment/roster` | session |
| POST | `/api/admin/salesforce/sync-users` | app-admin |
| GET | `/api/admin/scheduling` | app-admin |
| PATCH | `/api/admin/scheduling/:jobKey` | app-admin |
| POST | `/api/admin/scheduling/:jobKey/run-now` | app-admin |
| DELETE | `/api/admin/sessions/:id` | app-admin |
| GET | `/api/admin/sf-field-mappings` | app-admin |
| GET | `/api/admin/sf-users` | session |
| GET | `/api/admin/sf/departments` | app-admin |
| GET | `/api/admin/sf/fields` | app-admin |
| GET | `/api/admin/sf/objects` | app-admin |
| GET | `/api/admin/sf/picklist-values` | app-admin |
| GET | `/api/admin/sf/users` | app-admin |
| GET | `/api/admin/sync-history` | app-admin |
| GET | `/api/admin/sync-issues` | app-admin |
| POST | `/api/admin/sync-issues/:source/:id/resolve` | app-admin |
| GET | `/api/admin/teams` | session |
| POST | `/api/admin/teams` | app-admin |
| PATCH | `/api/admin/teams/:teamId` | app-admin |
| DELETE | `/api/admin/teams/:teamId` | app-admin |
| GET | `/api/admin/teams/:teamId/activity-types` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/activity-types` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/activity-types/:typeId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/activity-types/:typeId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/activity-types/:typeId/sf-extras` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/activity-types/:typeId/sf-extras` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/activity-types/:typeId/sf-extras/:extraId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/activity-types/:typeId/sf-extras/:extraId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/activity-types/:typeId/subtypes` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/activity-types/:typeId/subtypes` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/activity-types/:typeId/subtypes/:subtypeId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/activity-types/:typeId/subtypes/:subtypeId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/activity-types/export` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/activity-types/import/apply` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/activity-types/import/preview` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/attach-rate-fields` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/attach-rate-fields` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/attach-rate-fields/:fieldId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/attach-rate-fields/:fieldId` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/clone` | app-admin |
| GET | `/api/admin/teams/:teamId/flight-deck-items` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/flight-deck-items` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/flight-deck-items/:itemId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/flight-deck-items/:itemId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/flight-deck-items/:itemId/translations` | role: 'admin' |
| PUT | `/api/admin/teams/:teamId/flight-deck-items/:itemId/translations/:locale` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/flight-deck-items/:itemId/translations/:locale` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/flight-deck-items/reorder` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/flight-deck-items/seed-defaults` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/guide-distinctions` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/holiday-calendars` | app-admin |
| PUT | `/api/admin/teams/:teamId/holiday-calendars` | app-admin |
| GET | `/api/admin/teams/:teamId/keyword-rules` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/keyword-rules` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/keyword-rules/:ruleId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/keyword-rules/:ruleId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/nudge-dismissals` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/nudge-dismissals/:userId/:ruleId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/nudge-rules` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/nudge-rules` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/nudge-rules/:ruleId` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/nudge-rules/:ruleId` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/nudge-rules/:ruleId/preview` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/nudge-rules/:ruleId/translations` | role: 'admin' |
| PUT | `/api/admin/teams/:teamId/nudge-rules/:ruleId/translations/:locale` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/nudge-rules/:ruleId/translations/:locale` | role: 'admin' |
| POST | `/api/admin/teams/:teamId/seed-guide-content` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/sf-field-mappings` | app-admin |
| POST | `/api/admin/teams/:teamId/sf-field-mappings` | app-admin |
| PATCH | `/api/admin/teams/:teamId/sf-field-mappings/:mappingId` | app-admin |
| DELETE | `/api/admin/teams/:teamId/sf-field-mappings/:mappingId` | app-admin |
| GET | `/api/admin/teams/:teamId/sf-field-mappings/export` | app-admin |
| POST | `/api/admin/teams/:teamId/sf-field-mappings/import/apply` | app-admin |
| POST | `/api/admin/teams/:teamId/sf-field-mappings/import/preview` | app-admin |
| GET | `/api/admin/teams/:teamId/sf-field-mappings/sample` | app-admin |
| POST | `/api/admin/teams/:teamId/sf-field-mappings/validate` | app-admin |
| GET | `/api/admin/teams/:teamId/subteams` | app-admin |
| POST | `/api/admin/teams/:teamId/subteams` | app-admin |
| PATCH | `/api/admin/teams/:teamId/subteams/:subteamId` | app-admin |
| DELETE | `/api/admin/teams/:teamId/subteams/:subteamId` | app-admin |
| PATCH | `/api/admin/teams/:teamId/subtypes-enabled` | role: 'admin' |
| GET | `/api/admin/teams/:teamId/users` | role: 'admin', 'team_admin' |
| POST | `/api/admin/teams/:teamId/users` | role: 'admin' |
| DELETE | `/api/admin/teams/:teamId/users/:userId` | role: 'admin' |
| PATCH | `/api/admin/teams/:teamId/users/:userId/role` | role: 'admin' |
| GET | `/api/admin/themes` | app-admin |
| POST | `/api/admin/themes` | app-admin |
| PATCH | `/api/admin/themes/:id` | app-admin |
| DELETE | `/api/admin/themes/:id` | app-admin |
| POST | `/api/admin/themes/:id/clone` | app-admin |
| POST | `/api/admin/themes/email-preview` | app-admin |
| POST | `/api/admin/updates/check-now` | session |
| GET | `/api/admin/updates/settings` | app-admin |
| PUT | `/api/admin/updates/settings` | session |
| DELETE | `/api/admin/updates/settings` | session |
| GET | `/api/admin/updates/status` | app-admin |
| GET | `/api/admin/users` | session |
| POST | `/api/admin/users` | app-admin |
| PATCH | `/api/admin/users/:userId` | app-admin |
| GET | `/api/admin/users/:userId/notification-prefs` | app-admin |
| PUT | `/api/admin/users/:userId/notification-prefs` | app-admin |
| POST | `/api/admin/users/:userId/reset-mfa` | app-admin |
| POST | `/api/admin/users/:userId/reset-password` | app-admin |
| GET | `/api/admin/users/:userId/sf-alignment` | session |
| PUT | `/api/admin/users/:userId/sf-alignment` | session |
| GET | `/api/admin/users/:userId/sf-details` | app-admin |
| GET | `/api/admin/users/:userId/subteams` | app-admin |
| PUT | `/api/admin/users/:userId/subteams` | app-admin |
| POST | `/api/admin/users/:userId/verify-connection` | session |
| GET | `/api/admin/users/by-sf/:crmUserId` | app-admin |
| GET | `/api/admin/work-week-requests` | app-admin |
| POST | `/api/admin/work-week-requests/:id/approve` | app-admin |
| POST | `/api/admin/work-week-requests/:id/reject` | app-admin |

## `ai.ts` (4 endpoints)

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/ai/classify` | session |
| POST | `/api/ai/link-suggestions` | session |
| POST | `/api/ai/notes-chat` | session |
| POST | `/api/ai/organize-note` | session |

## `aiAdmin.ts` (8 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `` | public |
| POST | `/providers` | public |
| PATCH | `/providers/:id` | public |
| DELETE | `/providers/:id` | public |
| POST | `/providers/:id/default` | public |
| POST | `/providers/:id/test` | public |
| PUT | `/routes` | public |
| PUT | `/settings` | public |

## `auth.ts` (57 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/auth/api-keys` | session |
| POST | `/auth/api-keys` | session |
| DELETE | `/auth/api-keys/:id` | session |
| GET | `/auth/azure` | session |
| GET | `/auth/azure/callback` | session |
| GET | `/auth/azure/configured` | session |
| GET | `/auth/callback` | session |
| POST | `/auth/change-password` | session |
| POST | `/auth/forgot-password` | session |
| GET | `/auth/fx-rates` | session |
| GET | `/auth/holiday-calendars` | session |
| POST | `/auth/login` | session |
| POST | `/auth/logout` | session |
| GET | `/auth/me` | session |
| PATCH | `/auth/me/default-subteam` | session |
| PATCH | `/auth/me/default-team` | session |
| GET | `/auth/me/holiday-calendars` | session |
| PUT | `/auth/me/holiday-calendars` | session |
| GET | `/auth/me/holidays` | session |
| GET | `/auth/me/logins` | session |
| GET | `/auth/me/non-activity-keywords` | session |
| PATCH | `/auth/me/non-activity-keywords` | session |
| GET | `/auth/me/outlook-working-hours` | session |
| PATCH | `/auth/me/outlook-writeback` | session |
| GET | `/auth/me/preferred-currency` | session |
| PUT | `/auth/me/preferred-currency` | session |
| PATCH | `/auth/me/private-meetings-as-non-activity` | session |
| GET | `/auth/me/pto` | session |
| POST | `/auth/me/pto` | session |
| DELETE | `/auth/me/pto/:date` | session |
| GET | `/auth/me/teams` | session |
| PATCH | `/auth/me/timezone` | session |
| PATCH | `/auth/me/work-week` | session |
| GET | `/auth/me/work-week-request` | session |
| DELETE | `/auth/me/work-week-request/:id` | session |
| POST | `/auth/mfa/enroll` | session |
| POST | `/auth/mfa/regenerate-backup-codes` | session |
| POST | `/auth/mfa/verify` | session |
| POST | `/auth/mfa/verify-enrollment` | session |
| GET | `/auth/microsoft` | session |
| GET | `/auth/microsoft/callback` | session |
| POST | `/auth/microsoft/disconnect` | session |
| GET | `/auth/microsoft/status` | session |
| GET | `/auth/okta` | session |
| GET | `/auth/okta/configured` | session |
| POST | `/auth/reset-password` | session |
| POST | `/auth/reset-password/verify` | session |
| GET | `/auth/salesforce` | session |
| GET | `/auth/salesforce-admin` | app-admin |
| POST | `/auth/salesforce-admin/disconnect` | app-admin |
| GET | `/auth/salesforce-admin/status` | app-admin |
| GET | `/auth/salesforce/callback` | session |
| POST | `/auth/salesforce/disconnect` | session |
| GET | `/auth/salesforce/status` | session |
| GET | `/auth/sessions` | session |
| DELETE | `/auth/sessions` | session |
| DELETE | `/auth/sessions/:id` | session |

## `backup.ts` (5 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/export` | public |
| POST | `/import` | public |
| DELETE | `/import/:token` | public |
| POST | `/import/:token/apply` | public |
| GET | `/info` | public |

## `criteriaiq.ts` (5 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/criteriaiq/evaluation-link` | session |
| PUT | `/api/criteriaiq/evaluation-link` | session |
| DELETE | `/api/criteriaiq/evaluation-link` | session |
| GET | `/api/criteriaiq/projects` | session |
| GET | `/api/criteriaiq/projects/:id` | session |

## `crm.ts` (26 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/crm/accounts/:id/contacts` | session |
| GET | `/api/crm/activity-link-status` | session |
| GET | `/api/crm/evaluation-source` | session |
| GET | `/api/crm/evaluations/:relatedId` | session |
| PATCH | `/api/crm/evaluations/:relatedId` | session |
| GET | `/api/crm/evaluations/picklist-values` | session |
| GET | `/api/crm/features` | session |
| POST | `/api/crm/field-prepend` | session |
| GET | `/api/crm/field-prepend/meta` | session |
| GET | `/api/crm/opportunities/:id/assigned-se` | session |
| PATCH | `/api/crm/opportunities/:id/assigned-se` | session |
| GET | `/api/crm/opportunities/:id/field` | session |
| PATCH | `/api/crm/opportunities/:id/field` | session |
| GET | `/api/crm/opportunities/:id/related` | session |
| GET | `/api/crm/picklists/opportunity/assigned-se` | session |
| GET | `/api/crm/preview/:type/:id` | session |
| GET | `/api/crm/provider` | session |
| GET | `/api/crm/search/accounts` | session |
| GET | `/api/crm/search/campaigns` | session |
| GET | `/api/crm/search/contacts` | session |
| GET | `/api/crm/search/from-attendees` | session |
| GET | `/api/crm/search/leads` | session |
| GET | `/api/crm/search/opportunities` | session |
| POST | `/api/crm/suggestions/by-attendees` | session |
| GET | `/api/crm/tickets/refresh` | session |
| GET | `/api/crm/tickets/search` | session |

## `dashboards.ts` (41 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/dashboards/account-concentration` | session |
| GET | `/api/dashboards/activity-mix` | session |
| GET | `/api/dashboards/anomalies` | role: 'leader', 'admin' |
| GET | `/api/dashboards/attach-rate` | session |
| GET | `/api/dashboards/attach-rate-breakdown` | session |
| GET | `/api/dashboards/breakdown` | session |
| GET | `/api/dashboards/burn` | session |
| GET | `/api/dashboards/capacity-trend` | session |
| GET | `/api/dashboards/closed-lost-review` | session |
| POST | `/api/dashboards/closed-lost-review/dismiss` | role: 'leader', 'admin' |
| DELETE | `/api/dashboards/closed-lost-review/dismiss` | role: 'leader', 'admin' |
| GET | `/api/dashboards/fx-status` | session |
| GET | `/api/dashboards/heatmap` | session |
| GET | `/api/dashboards/history-accounts` | session |
| GET | `/api/dashboards/history-coverage` | session |
| GET | `/api/dashboards/history-overview` | session |
| GET | `/api/dashboards/logging-compliance` | session |
| GET | `/api/dashboards/logging-entry-heatmap` | session |
| GET | `/api/dashboards/logging-lag` | session |
| GET | `/api/dashboards/manager-rollup` | session |
| GET | `/api/dashboards/most-expensive` | session |
| GET | `/api/dashboards/my-acv-impact` | session |
| GET | `/api/dashboards/outlook-disconnected` | session |
| GET | `/api/dashboards/plan-vs-actual` | session |
| GET | `/api/dashboards/presets` | session |
| POST | `/api/dashboards/presets` | session |
| DELETE | `/api/dashboards/presets/:id` | session |
| GET | `/api/dashboards/products-breakdown` | session |
| GET | `/api/dashboards/project-costing` | session |
| POST | `/api/dashboards/refresh-opp-snapshots` | session |
| GET | `/api/dashboards/refresh-opp-snapshots/status` | session |
| GET | `/api/dashboards/revenue/cost-per-acv` | session |
| GET | `/api/dashboards/revenue/opp-roi` | session |
| GET | `/api/dashboards/sales-team-breakdown` | session |
| GET | `/api/dashboards/sf-disconnected` | session |
| GET | `/api/dashboards/stage-forecast-options` | session |
| GET | `/api/dashboards/team-activity-deep-dive` | session |
| GET | `/api/dashboards/this-week-capacity` | session |
| GET | `/api/dashboards/user-leaderboard` | session |
| GET | `/api/dashboards/won-without-poc` | session |
| GET | `/api/dashboards/wow-delta` | session |

## `flightDeck.ts` (3 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/flight-deck` | session |
| PATCH | `/api/flight-deck/items/:itemId/complete` | session |
| PATCH | `/api/flight-deck/preference` | session |

## `history.ts` (2 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/history/by-sf` | session |
| GET | `/api/history/me` | session |

## `mcp.ts` (2 endpoints)

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/mcp` | public |
| GET | `/api/mcp` | public |

## `non-activities.ts` (3 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/non-activities` | session |
| POST | `/api/non-activities` | session |
| DELETE | `/api/non-activities/:outlookEventId` | session |

## `notes.ts` (5 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/notes` | session |
| POST | `/api/notes` | session |
| PATCH | `/api/notes/:id` | session |
| DELETE | `/api/notes/:id` | session |
| POST | `/api/notes/:id/push` | session |

## `notifications.ts` (6 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/notifications` | session |
| DELETE | `/api/notifications/:id` | session |
| PATCH | `/api/notifications/:id/read` | session |
| GET | `/api/notifications/prefs` | session |
| PUT | `/api/notifications/prefs` | session |
| POST | `/api/notifications/read-all` | session |

## `nudges.ts` (3 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/nudges` | session |
| POST | `/api/nudges/dismiss` | session |
| POST | `/api/nudges/mark-read` | session |

## `outlook.ts` (7 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/outlook/calendar` | session |
| POST | `/api/outlook/refresh` | session |
| GET | `/api/outlook/status` | session |
| GET | `/api/outlook/suggestions` | session |
| PATCH | `/api/outlook/suggestions/:eventId/override` | session |
| POST | `/api/outlook/suggestions/:eventId/recompute` | session |
| GET | `/api/outlook/writeback-config` | session |

## `salesforce.ts` (29 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/salesforce/accounts/:id/contacts` | session |
| GET | `/api/salesforce/activity-link-status` | session |
| GET | `/api/salesforce/evaluations/:relatedId` | session |
| PATCH | `/api/salesforce/evaluations/:relatedId` | session |
| GET | `/api/salesforce/evaluations/picklist-values` | session |
| POST | `/api/salesforce/field-prepend` | session |
| GET | `/api/salesforce/field-prepend/meta` | session |
| GET | `/api/salesforce/me/tz` | session |
| GET | `/api/salesforce/opportunities/:id/assigned-se` | session |
| PATCH | `/api/salesforce/opportunities/:id/assigned-se` | session |
| PATCH | `/api/salesforce/opportunities/:id/field` | session |
| GET | `/api/salesforce/opportunities/:id/field` | session |
| GET | `/api/salesforce/opportunities/:id/related` | session |
| POST | `/api/salesforce/opportunities/accounts` | session |
| GET | `/api/salesforce/picklists/opportunity/assigned-se` | session |
| GET | `/api/salesforce/preview/:type/:id` | session |
| GET | `/api/salesforce/search/accounts` | session |
| GET | `/api/salesforce/search/campaigns` | session |
| GET | `/api/salesforce/search/contacts` | session |
| GET | `/api/salesforce/search/from-attendees` | session |
| GET | `/api/salesforce/search/leads` | session |
| GET | `/api/salesforce/search/opportunities` | session |
| GET | `/api/salesforce/search/users` | session |
| GET | `/api/salesforce/sobjects` | session |
| GET | `/api/salesforce/sobjects/:sobject/fields` | session |
| POST | `/api/salesforce/suggestions/by-attendees` | session |
| GET | `/api/salesforce/tickets/refresh` | session |
| GET | `/api/salesforce/tickets/search` | session |
| GET | `/api/salesforce/users` | session |

## `scheduling.ts` (2 endpoints)

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/scheduling/refresh` | session |
| GET | `/api/scheduling/week` | session |

## `setup.ts` (10 endpoints)

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/setup/ai-provider` | public |
| POST | `/api/setup/create-admin` | public |
| POST | `/api/setup/crm-provider` | public |
| GET | `/api/setup/generate-key` | public |
| POST | `/api/setup/migrate` | public |
| GET | `/api/setup/status` | public |
| POST | `/api/setup/test-ai-provider` | public |
| POST | `/api/setup/test-db` | public |
| POST | `/api/setup/test-okta` | public |
| POST | `/api/setup/test-salesforce` | public |

## `teams.ts` (14 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/teams` | session |
| GET | `/api/teams/:teamId/activity-type-subtypes` | session |
| GET | `/api/teams/:teamId/activity-types` | session |
| GET | `/api/teams/:teamId/announcements` | role: 'leader', 'admin' |
| POST | `/api/teams/:teamId/announcements` | role: 'leader', 'admin' |
| PATCH | `/api/teams/:teamId/announcements/:id` | role: 'leader', 'admin' |
| DELETE | `/api/teams/:teamId/announcements/:id` | role: 'leader', 'admin' |
| GET | `/api/teams/:teamId/guide-distinctions` | session |
| GET | `/api/teams/:teamId/members` | session |
| GET | `/api/teams/:teamId/nudge-rules` | session |
| GET | `/api/teams/:teamId/products` | session |
| GET | `/api/teams/:teamId/sf-field-mappings` | session |
| GET | `/api/teams/:teamId/subteams` | session |
| GET | `/api/teams/:teamId/subteams/:subteamId/members` | session |

## `templates.ts` (4 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/templates` | session |
| POST | `/api/templates` | session |
| PATCH | `/api/templates/:id` | session |
| DELETE | `/api/templates/:id` | session |

## `themes.ts` (4 endpoints)

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/themes` | public |
| GET | `/api/themes/active` | public |
| GET | `/api/themes/login-logo` | public |
| GET | `/api/themes/support-email` | public |

<!-- END AUTOGEN -->
