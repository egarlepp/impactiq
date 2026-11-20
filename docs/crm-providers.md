# CRM providers: Salesforce, HubSpot, CriteriaIQ

> The CRM provider layer, the HubSpot provider phase by phase, and the Projects (CriteriaIQ) source. Read before touching services/crm, services/hubspot or services/criteriaiq.
> Moved out of CLAUDE.md in v1.412.1 to keep that file short. Content is unchanged; section numbers (§) refer to CLAUDE.md.

### CRM provider layer *(v1.383+)*

Groundwork for HubSpot (phase 1b of the HubSpot plan; see project memory `hubspot-integration-plan`).
One install talks to one CRM, never two.

- **`crm_provider` setting** — `system_settings` key `crm_provider`, `{provider: 'salesforce' | 'hubspot' | 'none'}`,
  read through `services/crm/providerSetting.ts` (`getCrmProviderId()`, 30s cache, cleared on write and after a backup
  restore). Defaults to `'salesforce'`, and anything unreadable also reads as Salesforce, so an install that predates the
  setting is unchanged and a bad row can never switch the CRM off. `'hubspot'` is accepted but has no implementation
  until phase 2, so it behaves like `'none'`, and neither UI offers it yet (`availableCrmProviderIds()` lists only
  built providers plus `'none'`; HubSpot shows as "coming soon").
- **Choosing the CRM + the lock** *(v1.384+)* — chosen on Setup wizard step 6 (`POST /api/setup/crm-provider`) and on
  Admin → Integrations → **CRM** (`CrmProviderCard.tsx`, `GET`/`PUT /api/admin/integrations/crm-provider`, App Admin,
  audited `integration.crm_provider.update`). The setting also stores `dataProvider`, the CRM the install's links came
  from (defaults to Salesforce for older rows). Once any CRM-linked data exists (an activity with a What/Who/Related id or
  a write-back `sf_record_id`, an `activity_sf_tickets` row, or an `sf_historical_events` row:
  `services/crm/providerLock.ts`'s `countCrmLinkedData()`), the only allowed moves are between `dataProvider` and
  `'none'`; anything else is 409 `errors.crm.provider_locked`, since record ids don't carry across CRMs. The rule itself
  is `crmProviderChangeAllowed()` in `src/shared/crmProvider.ts`, shared by the admin route, the Setup route and the
  card. No "clear CRM links" reset path yet, so an install already linked to Salesforce can't move to HubSpot; this is a
  known limit (`docs/crm.md` §3.5) and on the roadmap (CLAUDE.md §18, "CRM switch-over").
  With Salesforce not active, `/auth/salesforce/status` reports not configured (sidebar button, My Settings and banners
  all follow), the `/auth/salesforce` and `/auth/salesforce-admin` OAuth starts answer 409, and Admin → Integrations
  hides the admin Salesforce connection card. *(v1.407+)* Any CRM can be chosen before its connection is saved, the same
  for Salesforce and HubSpot: the state carries `configured: {salesforce, hubspot}` and the card shows an amber "not set
  up yet" warning (and a line in the confirm dialog) instead of refusing. Every CRM's connection card is always listed,
  with `InactiveCrmNote` (`CrmProviderCard.tsx`) inside the one that isn't the chosen CRM.
- **CRM words on screen** — `useCrmLabelContext()` (`store/crmProvider.ts`, reads `GET /api/crm/provider`) gives an
  i18next context: `t('sf.opportunity', { context: crmCtx })` reads `sf.opportunity_hubspot` ("Deal") on HubSpot and
  the plain key otherwise. Variants exist for `sf.opportunity`/`sf.account` and `activity.sf.opportunity_label`/
  `account_label` in all 7 locales, used by the Salesforce Link search tabs, activity cards and the relationship help.
  The rest of the app's Opportunity/Account wording moves over in the HubSpot phases as each surface is touched.
- **`CrmProvider` interface** (`services/crm/types.ts`) — `connectForUser(userId)` returns a `CrmUserSession`
  (search Opportunities/Accounts/Contacts/Leads/Campaigns, live preview read) running as that user's own connection, or
  null when they aren't connected; plus `queueActivitySync()` and `refreshSnapshots()`. Record shapes stay ImpactIQ's
  canonical kinds with today's field names; a provider translates its own objects at the boundary.
  `services/crm/salesforceProvider.ts` is a thin adapter over the existing Salesforce services with the same arguments,
  and `provider.test.ts` proves it sends Salesforce byte-identical SOQL to the direct calls. Use
  `getActiveCrmProvider()` (null when no CRM is active) and `queueCrmActivitySync()` from `services/crm/index.ts` rather
  than calling Salesforce code from routes; the activity save path, MCP `salesforce.search_opportunities` and the
  dashboard Refresh button already do.
- **Enforced on the server** — `requireCrmProvider('salesforce')` guards the whole `/api/salesforce/*` router (409
  `errors.crm.provider_mismatch` when the install runs another CRM), and every Salesforce scheduled job
  (`writeback_worker`, `notes_push_worker`, `refresh_opp_snapshots`, `refresh_opp_coverage`, `detect_disconnected_links`,
  `refresh_historical_opps`) returns quietly on a tick when Salesforce isn't the active CRM, writing no `job_runs` row.
  New Salesforce routes or jobs get the same guard; a new CRM-neutral caller goes through the provider.
- **Projects (Evaluations) source + CriteriaIQ connection** *(v1.385+, HubSpot phase 1d)* — `system_settings` key
  `evaluation_source` = `{primary: 'crm' | 'criteriaiq' | 'off', dataSource, criteriaiqSecondary}` (`src/shared/evaluationSource.ts`,
  read via `services/criteriaiq/evaluationSource.ts`, 30s cache cleared on write and after a restore). Defaults to the CRM
  object with no secondary, so nothing changes for existing installs. The primary is locked once any activity has an
  `sf_related_id` (only the links' own source or `off` allowed, 409 `errors.evaluation_source.locked`); the secondary is
  never locked and only allowed beside the CRM object. Offered today (`services/criteriaiq/availability.ts`): `crm`, `off`
  (v1.387+) and `criteriaiq` (v1.388+) as primary, and CriteriaIQ as secondary (v1.386+); CriteriaIQ as primary needs the
  CriteriaIQ connection first. The CriteriaIQ connection (`criteriaiq_config`: base URL, API key
  encrypted with `encryptToken`, `allowPrivateNetwork`) and the read-only client (`services/criteriaiq/client.ts`:
  `testCriteriaIqConnection`, `getCriteriaIqProject`, `findCriteriaIqProjectsByCrmRecord`) need a CriteriaIQ API key with
  `projects:read`. URLs go through `assertCriteriaIqUrl()` (`ssrfGuard.ts`): public https only, unless the admin ticks the
  private-network option, which allows a private address (and plain http only to one) but still blocks loopback, link-local
  /metadata and IPv4-mapped forms of them; redirects are never followed. On an older CriteriaIQ (no summary API, below)
  `findCriteriaIqProjectsByCrmRecord` reads `GET /api/projects` (cached 5 min) and matches the id inside each project's
  `salesforceEvaluationLink` (15- or 18-char, whole id). Admin → Integrations → **Projects (POC|POV)** card (titled "Projects (Evaluations)" before v1.386.1) (`EvaluationSourceCard.tsx`), routes
  `GET`/`PUT /api/admin/integrations/evaluation-source` and `GET`/`PUT`/`DELETE /api/admin/integrations/criteriaiq` plus
  `POST .../criteriaiq/test` and `GET .../criteriaiq/lookup?recordId=`, all App Admin; audited
  `integration.evaluation_source.update`, `integration.criteriaiq.save`/`.clear`.
- **CriteriaIQ secondary panel on the drawer** *(v1.386+)* — with the secondary on, `EvalFieldsPanel` (activity drawer's
  Project box and the SF Activities drill-in) mounts `CriteriaIqPanel.tsx` under the CRM Evaluation's fields: the matched
  CriteriaIQ project's status (TCC shows up here), criteria progress (active success criteria met / total, met = status
  `pass`/`passed`/`met`, CriteriaIQ's own rule), and a link out. `GET /api/criteriaiq/evaluation-link?recordId=&oppName=`
  (`routes/criteriaiq.ts`, any signed-in user, returns `{state:'off'}` while the secondary is off so the panel renders
  nothing) resolves via `services/criteriaiq/evaluationLink.ts`: exactly one project whose Evaluation link holds the record
  id links on its own; otherwise a stored choice wins; otherwise several Evaluation matches, or projects whose Opportunity
  name equals the linked Opportunity's (CriteriaIQ stores the Opportunity only by name, so these are never auto-linked),
  are offered in a picker. Choices live in `criteriaiq_evaluation_links` (migration 0154), keyed by the CRM record id,
  not the activity, so every activity on the Evaluation agrees; `PUT`/`DELETE` on the same route set or clear one (only a
  current candidate can be chosen), audited `criteriaiq.evaluation_link.set`/`.clear`. The summary sent to the client
  leaves out engineer notes. The CRM value always wins: `findCriteriaIqMismatches()` (`src/shared/criteriaiqMismatch.ts`)
  compares status (case/`_`/`-` insensitive), start/end date (by day) and Primary Engineer against the local `sf_eval_*`
  snapshot and the panel only flags differences. A CriteriaIQ outage shows a one-line notice and never touches the CRM
  fields.
- **Projects Off** *(v1.387+)* — primary `off` hides every Project feature and the server enforces it.
  `GET /api/activities/sf-extras/:typeId` leaves out `related_object_picker` rows, which removes the Project picker from
  the form, the suggested-meeting card (`ProjectMatchChip`) and the card's label lookup in one place. `requireProjectsOn()`
  (`services/criteriaiq/evaluationSource.ts`, 409 `errors.evaluation_source.projects_off`) guards the Project-only
  routes: `/api/salesforce/opportunities/:id/related`, `/evaluations/*`, `/field-prepend*`, `/api/activities/eval-fields`,
  and the `won-without-poc` / `project-costing` dashboards. `POST`/`PATCH /api/activities` refuse a new or changed
  `sfRelatedId` (`isBlockedProjectLink()`, `src/shared/evaluationSource.ts`) but keep or clear an existing one, the same
  keep-existing-links contract as the Campaigns/Leads switches. `refresh_opp_snapshots` skips the `evaluation_lookup`
  patch and the Project field refresh, so no link is added while off. Client screens read `useProjectsEnabled()`
  (`store/evaluationSource.ts`, `GET /api/crm/evaluation-source`) to hide the activity card's Project chip and drill-in,
  the Engineer Notes checkbox (form, Notes drawer, My Notes) and the two Project dashboard tabs. Saved links, snapshots
  and `criteriaiq_evaluation_links` rows are never touched, so turning Projects back on (to the links' own source)
  restores everything. Off also turns the CriteriaIQ secondary off. `detect_disconnected_links` still checks Related
  links, so their flags stay accurate for when Projects come back.
- **CriteriaIQ as primary** *(v1.388+)* — a Project link reuses the same activity columns as a CRM Evaluation link:
  `sf_related_type = 'CriteriaIQ'` (`CRITERIAIQ_RELATED_TYPE`, `src/shared/evaluationSource.ts`), `sf_related_id` = the
  CriteriaIQ project id, plus `sf_related_name` and the `sf_eval_*` snapshot (`sf_eval_stage` stays null, CriteriaIQ has
  no Stage), so Project-Specific Costing and the activity card work unchanged. Which activity types show a picker is still
  the `related_object_picker` SF Extra; under CriteriaIQ primary its config is just `{sobject: 'CriteriaIQ', label}`
  (Admin → Activity Types shows a label-only "Project picker" form) and the form renders `CriteriaIqProjectPicker.tsx`
  instead of the Salesforce related picker: suggestions are the CriteriaIQ projects whose Opportunity name equals the
  linked Opportunity's, plus a search by name/customer/Opportunity (`GET /api/criteriaiq/projects?oppName=&q=`,
  `GET /api/criteriaiq/projects/:id`, 409 `errors.evaluation_source.not_criteriaiq` unless CriteriaIQ is primary).
  `ProjectMatchChip` offers the same suggestions on the suggested-meeting card. Every save runs `checkProjectLink()`
  (`services/criteriaiq/primaryProjects.ts`): 403 while off, 400 `errors.evaluation_source.wrong_project_source` for a
  link from the other source (`isWrongSourceProjectLink()`), and under CriteriaIQ it reads the project server-side for the
  snapshot (400 `errors.criteriaiq.project_not_found` when CriteriaIQ says it doesn't exist; a CriteriaIQ outage keeps the
  link without a snapshot rather than blocking the save). Nightly `refresh_criteriaiq_projects` (24h, Admin → Scheduling)
  refreshes each linked project from one list read, falls back to a single read, and sets `sf_related_deleted` only on a
  confirmed 404; it writes no run row unless CriteriaIQ is primary and links exist. Won w/o POC checks CriteriaIQ instead
  of Salesforce (an Opportunity has a POC when an activity on it links a CriteriaIQ project or a project names it; a
  CriteriaIQ outage shows a notice, never a false "no POC"). The Salesforce-Evaluation-only routes (`/related`,
  `/evaluations/*`, `/field-prepend*`) use `requireCrmProjects()` (409 `errors.evaluation_source.not_crm`), so Engineer
  Notes posting is hidden (`useCrmProjects()`). Salesforce code never reads a CriteriaIQ id: `refresh_opp_snapshots`,
  `detect_disconnected_links`, the drawer's link-status check and the CRM provider lock all skip `'CriteriaIQ'` links.
  Known limits: suggestions need a linked Opportunity (search works without one), no hover preview on a CriteriaIQ link,
  and a deleted CriteriaIQ project reuses the "SF link broken" badge.
- **CriteriaIQ projects matched by CRM id** *(v1.409+)* — CriteriaIQ (v0.9+, its migration 086) stores
  `crmProvider`, `crmOpportunityId` (Salesforce Opportunity or HubSpot Deal id) and `crmAccountId` (Account or Company id)
  on each project and filters `GET /api/projects` by them. ImpactIQ reads that API, never CriteriaIQ's tables:
  `findCriteriaIqProjectsForOpportunity({id, name})` (`services/criteriaiq/client.ts`) asks
  `?crmOpportunityId=` and checks each returned row's id itself (an older CriteriaIQ ignores the filter and returns
  everything, none with ids); only when nothing matches does it fall back to the Opportunity name, skipping projects
  CriteriaIQ ties to a different Opportunity. `findCriteriaIqProjectsForAccount()` uses `?crmAccountId=` (no name
  fallback). Ids compare through `normalizeCrmId()` (Salesforce 18 → 15 characters, HubSpot ids as-is). Once the cached
  list shows a CriteriaIQ without the id fields, the filtered requests stop. Used by the primary picker
  (`GET /api/criteriaiq/projects?oppId=&oppName=&accountId=&q=` returns `suggested`, `matchedBy: 'id' | 'name'`,
  `accountSuggested`; the picker notes a name match and lists "Other projects on this Account"), `ProjectMatchChip`,
  the secondary panel's Opportunity fallback (`evaluation-link` now takes `oppId`), and Won w/o POC (a project with an
  Opportunity id counts by id only; a project without one still matches by name). Evaluation-link matching is unchanged.
- **CriteriaIQ summary API** *(v1.447+)* — CriteriaIQ v0.11+ serves a versioned, read-only contract,
  `GET /api/v1/projects/:id/summary` and `GET /api/v1/projects/summary?crmOpportunityId=|crmAccountId=|evaluationId=`
  (`ProjectSummaryV1`, CriteriaIQ's `docs/features/project-summary-api.md`; same `projects:read` key). The client
  (`services/criteriaiq/client.ts`) probes it once per URL and key (`summaryApiSupported()`: the lookup without a filter
  answers 400 with a JSON message; an older CriteriaIQ answers 403/404, cached 30 min) and then uses it for
  `getCriteriaIqProject`, the Opportunity/Account id lookups and `findCriteriaIqProjectsByCrmRecord`
  (`?evaluationId=`, each link still re-checked). Search, the nightly snapshot refresh and the name fallback still read
  `GET /api/projects`. `fromCriteriaIqSummary()` maps a summary: criteria counts are CriteriaIQ's own (met = status
  `complete`; cancelled/deferred criteria left out of the total), plus MAP task progress (`mapTasksTotal` /
  `mapTasksCompleted`, shown on the drawer's CriteriaIQ panel). The link is built from the configured URL, never taken
  from the response. The older path now also counts `complete` as met (it only counted pass/passed/met, words
  CriteriaIQ never uses, so every project read 0 met).
- **Effort API for CriteriaIQ** *(v1.448+)* — the other direction: CriteriaIQ reads ImpactIQ hours to show SE effort
  on a project page. `GET /api/v1/effort?crmOpportunityId=` (`routes/effortApi.ts`, mounted before the session `/api`
  router) takes only an `iqk_` key with the `effort:read` scope (a `rest:full` or MCP key gets 403, a session cookie
  401); the owner must still be a Team Leader/admin when the call is made (`hasAnyLeaderOrAdminRole()`, the same gate as
  minting the scope), and only the owner's `getAccessibleTeamIds()` count. It returns totals only
  (`services/activities/opportunityEffort.ts`: hours, count, first/last activity, by person with lower-cased email, by
  activity type name), from submitted, unarchived activities whose primary record is that Opportunity; a Salesforce id
  matches on its 15-char form. Per-key limits reuse `mcpRateCheck()`. *(v1.449+)* It also returns one `cost` total (USD,
  labor + direct, the cost dashboards' math), never per person or type, and `?openOpportunity=<id>&name=` on any page
  opens the activities drawer for that Opportunity (`OpportunityDeepLink.tsx`). Contract: `docs/effort-api.md`.
- **CriteriaIQ live refresh** *(v1.450+)* — CriteriaIQ pushes a signed webhook when a project changes, so ImpactIQ no
  longer waits out its 5-minute read cache and the nightly `refresh_criteriaiq_projects`. Admin → Integrations →
  CriteriaIQ connection → Live refresh (App Admin, `POST`/`DELETE /api/admin/integrations/criteriaiq/live-refresh`,
  audited `integration.criteriaiq.live_refresh.*`) makes a signing secret, shown once and stored encrypted as
  `webhookSecretEncrypted` in `criteriaiq_config`; New secret rotates it. In CriteriaIQ the admin adds a webhook (Generic
  or n8n template) to `POST /api/webhooks/criteriaiq` (`routes/criteriaiqWebhook.ts`, mounted before the session `/api`
  router, raw body, CSRF-exempt, global per-IP limit) for `project.created`, `project.updated`, `criteria.updated` and
  the MAP status events. Only `X-CriteriaIQ-Signature-V2: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>`
  (CriteriaIQ v0.11+) is accepted, never the older body-only header, which can be replayed (`services/criteriaiq/webhook.ts`):
  `t` within 5 minutes, constant-time compare, and each accepted signature is a row in `criteriaiq_webhook_receipts`
  (migration 0172, rows over an hour old deleted as new ones arrive), so a replay is refused on every replica (200
  `duplicate`, so CriteriaIQ doesn't retry). 404 while live refresh is off. An accepted delivery moves `cacheEpoch` in
  `criteriaiq_config`, which is part of every cache key in `client.ts`; since each CriteriaIQ read already loads that row,
  every replica drops its cached reads on its next call with no extra query. Then, with CriteriaIQ as primary and an
  activity linking the project, `refreshCriteriaIqProject(id)` (`primaryProjects.ts`) re-reads that one project by the
  nightly job's rules. Only the event name and project id are read from the body; the project itself always comes back
  through CriteriaIQ's API. The card shows the last delivery time. *(v1.453+)* The admin-facing setup steps for the whole
  link (API key, connection, live refresh webhook, SE effort key, troubleshooting) live in How to Use ImpactIQ's
  `criteriaiq` section (`how_to_use.criteriaiq_body`), linked from the card; keep it in step with CriteriaIQ's menus.
- **HubSpot connection, owner matching and access check** *(v1.389+, HubSpot phase 2a)* — the connection
  the HubSpot provider (v1.390+, next bullet) runs on. Auth is a **service key or private app access token** for the whole portal (the owner's choice; both are sent the same way, and a service key from Development → Keys → Service Keys is the recommended one), not OAuth: no per-user HubSpot login,
  so an ImpactIQ user's HubSpot owner is the owner with the same email (case-insensitive). The token lives in
  `system_settings` key `hubspot_config` (encrypted with `encryptToken`, plus `portalId`/`portalName`/`accountType`/
  `uiDomain` and the last access check; `services/hubspot/config.ts`). `services/hubspot/client.ts` only ever calls
  `https://api.hubapi.com` (callers pass a path, never a host), sends no redirects, turns failures into
  `errors.hubspot.*` keys, retries a per-second 429 up to 3 times and gives up on the daily limit. Every call waits on
  `services/hubspot/rateLimiter.ts` (in-process sliding window, 90/10s by default, follows `X-HubSpot-RateLimit-Max`
  with a 10% margin; search endpoints also 4/s). **Access check** (`capabilities.ts`): a private app's scopes can't be
  read back, so each capability is probed: reads fetch one record/property (2xx ok), writes PATCH id `0` with no
  properties (404/400 = allowed, never creates data); 403 = missing, anything else unknown, 401 stops the check. 8
  capabilities are required (deals/companies/contacts/owners read, their field schemas, meeting write); tickets, leads,
  campaigns, custom objects and deal write are reported but optional. **Owners** (`owners.ts`): `hubspot_owners`
  (migration 0155, index on `lower(email)`) holds active and archived owners, refreshed by the daily
  `hubspot_owner_sync` job (no run row unless HubSpot is connected) or the card's Sync owners button;
  `getHubspotOwnerIdForUser()` matches active owners only. **Rules** (`connection.ts`): a token is checked with
  HubSpot before it's saved (account-info for the portal name, falling back to the owners list); a token for a
  different portal is refused (409 `errors.hubspot.portal_locked`) once the install holds HubSpot-linked data, and a
  new portal clears the copied owners; the connection can't be removed while HubSpot is the active CRM (409
  `errors.hubspot.in_use`). Admin → Integrations → **HubSpot** (`HubspotConnectionCard.tsx`; *(v1.389.2)* always listed beside
  the Salesforce card, same Configure-toggle layout, with the scopes to grant listed before a key is saved; the
  scope names live in `HUBSPOT_CAPABILITY_SCOPES`, `src/shared/hubspot.ts`), routes `GET`/`PUT`/`DELETE /api/admin/integrations/hubspot`,
  `POST .../hubspot/test`, `POST .../hubspot/sync-owners`, all App Admin, audited `integration.hubspot.save`/
  `.clear`/`.sync_owners`. Test portal: HubSpot developer test account, portal 247756533; reaching it from a cloud
  session needs `api.hubapi.com` allowed in the environment's network settings. *(v1.389.1)* Live-checked against
  that portal with a service key: all 8 required capabilities ok, leads and campaigns missing (no Marketing Hub). HubSpot's
  account-info returns no portal name there, so the card falls back to the portal's domain.
- **HubSpot provider: search, previews, write-back** *(v1.390+, HubSpot phase 2b part 1)* — `services/crm/hubspotProvider.ts`
  registers HubSpot, so the CRM card and Setup step 6 offer it. It can be chosen before its connection is saved
  (*(v1.407+)*; until then its routes answer `errors.hubspot.not_configured` and its jobs stand down). **Routes**: `/api/salesforce/*` stays
  Salesforce-only, so HubSpot is served by the CRM-neutral `/api/crm/search/{opportunities,accounts,contacts,leads,campaigns}`
  and `/api/crm/preview/:type/:id` (`routes/crm.ts`, 60/min per user, 401 `errors.crm.not_connected`, 502 on a HubSpot
  failure). The client picks the base with `crmApiBaseFor()` / `useCrmApiBase()` (`store/crmProvider.ts`): SfSearch,
  the hover preview and the activity form's business breakdown use it; Salesforce-only extras (attendee suggestions,
  SF user search in the owner picker, Relink) stay hidden on HubSpot. **Search** (`services/hubspot/search.ts`): Deals
  default to the user's own (matched owner, or an SE property mapped as app field `deal_se_owner` on `deals`), Open
  Search drops that filter, closed Deals need Show Closed; the primary Company association fills the Account. Leads
  and Campaigns follow the last access check (a missing capability returns nothing) and are built from HubSpot's docs,
  not verified live (the test portal has neither). **Preview** (`preview.ts`): standard Deal/Company properties plus any
  mapped `deals` app fields (ACV, Assigned SE, Primary Engineer, Total Bookings breakdown); forecast reads
  `hs_manual_forecast_category`. **Write-back** (`writeback.ts`, job `hubspot_writeback_worker`, 30s, same
  "log only real work" gate): reuses the `sf_*` sync columns and `activity_sync_audit`; an activity type's SF object picks
  the engagement (Event → meeting, Task → task); standard properties are written by name, portal-specific ones only via
  mappings with `sf_object` `meetings`/`tasks` (constants last); associations (v4 default) link the Deal, its Company,
  the Who Contact/Lead and attendee Contacts found by email, the Deal set exact on update, others add-only; a 404 on
  update clears the record id and recreates, other failures retry on Salesforce's own backoff
  (`MAX_SYNC_RETRIES`/`retryBackoffMs`). HubSpot mappings live in `sf_field_mappings` with a HubSpot object name in
  `sf_object` and team scope through the junction (`services/hubspot/mappings.ts`). The nightly Deal snapshot refresh
  shipped in v1.393 (next bullet but one).
- **Meetings HubSpot already logged** *(v1.410+)* — a rep whose Outlook or Google calendar is connected to HubSpot gets
  meetings logged by HubSpot itself, so ImpactIQ creating its own on approval showed the meeting twice. Before creating a
  meeting, `syncHubspotActivity()` calls `findExistingHubspotMeeting()` (`services/hubspot/meetingMatch.ts`): a meetings
  search by `hubspot_owner_id` and `hs_timestamp` ±60s, then `pickMatchingMeeting()` keeps the same owner with start AND
  end within 60s (no end time = no match), skips ids another activity already holds in `sf_record_id`, and prefers the
  same title, then the oldest. Owner only, never title alone: another rep's synced meeting isn't ImpactIQ's to write on.
  A found meeting is **adopted**: `activities.crm_record_adopted` (migration 0158) is set, and from then on
  `buildHubspotEngagement({adopted: true})` writes only ImpactIQ's own fields (type, effort, constants, notes into
  `hs_internal_meeting_notes`), never `hs_timestamp`/title/start/end/owner/`hs_meeting_body`/description, even through
  a mapping or constant; associations are add-only (no `unlinkOtherDeals`); the delete and Outlook-deleted purge routes
  leave it in HubSpot. A 404 clears both the id and the flag. A failed search is retried, never read as "none found".
  CRM features switch **Create HubSpot meetings** (`crm_features.hubspotCreateMeetings`, default on, row shown only on
  HubSpot): off means a meeting with no match fails with a retryable reason (CRM Sync reason `hs_meeting_wait`) and is
  checked again on the normal backoff; tasks are always created. Tests: `hubspot/writeback.test.ts`.
- **HubSpot field mappings: pickers + validation** *(v1.391+, HubSpot phase 2b part 2)* — with HubSpot as the CRM,
  Admin → SF Field Mappings reads "HubSpot Field Mappings" (i18next `_hubspot` context on every Salesforce-worded key
  there) and shows only HubSpot rows; the other CRM's rows stay stored and exported, with a "N hidden" note. Objects are
  meetings/tasks (written by `buildHubspotEngagement()`) and deals (read by search and previews); the allowed app fields
  per object are `HUBSPOT_APP_FIELDS` in `src/shared/hubspot.ts`, and constants only apply to meetings/tasks. The property
  picker reads `GET /api/admin/hubspot/properties?object=` (App Admin, a fresh read of HubSpot's properties API, folded
  into the Salesforce field shape by `toPropertyField()` in `services/hubspot/metadata.ts`, so a property's options feed
  the constant input). **Validate & dry run** branches on the CRM: `services/hubspot/mappingValidation.ts` returns the
  same `ValidationResult` the Salesforce validator does, so the panel is unchanged. Checks: duplicates, app fields
  nothing reads, read-only rows that switch off a standard meeting/task property, constants that are never written,
  property exists, writable (not read-only or calculated), value type fits, constants and every active activity type's
  value are options of an enumeration, the SE Deal filter is an owner property, Deal money fields are numbers. The dry
  run is the write-back's own `buildHubspotEngagement()` on the team's latest submitted activity. **Sample record**
  reads one record of the object with the mapped properties (owner ids and options shown as names). The Salesforce
  validator now skips HubSpot rows. Pure checks are unit-tested in `hubspot/mappingValidation.test.ts`.
- **HubSpot Deal snapshot refresh + Deal filters** *(v1.393+, HubSpot phase 3)* — `services/hubspot/refreshSnapshots.ts`,
  job `refresh_hubspot_snapshots` (24h, Admin → Scheduling, first tick 60s after boot; no run row unless HubSpot is the
  active CRM and connected). Reads every Deal id on `activities` (`sf_what_type = 'Opportunity'`, only ids matching
  `HUBSPOT_ID_RX`, so a leftover Salesforce id is never sent to HubSpot) with batch reads of 100, plus each Deal's primary
  Company (v4 associations). Writes the same snapshot columns as the Salesforce refresh, as the labels people read: stage
  label (pipeline metadata), `hs_manual_forecast_category` option label, amount, close date, owner id + name, Assigned SE /
  Primary Engineer from the mapped `deals` properties (option label, else owner name), `sf_is_closed`/`sf_is_won`
  (`hs_is_closed*`, else the stage's metadata) and the Company. A Deal HubSpot no longer returns keeps its old snapshot;
  a missing association keeps the stored Company. A failed batch is logged and skipped; a 401 stops the run. Linked Lead
  ids get their primary Company in `sf_lead_account_link` (reuses the Salesforce `bulkUpsertLeadLinks()`), skipped when
  the last access check marks leads missing. `refreshSnapshots` on the HubSpot provider is this function, so the
  dashboard Refresh button works. Shares the `opp_snapshot` state row with Salesforce (only one CRM is ever active).
  `GET /api/dashboards/stage-forecast-options` on HubSpot returns the Deal stage labels in pipeline order, forecast option
  labels, and `stageGroups` (label → pipeline name, only with 2+ pipelines) from `getDealFilterOptions()`
  (`hubspot/metadata.ts`), falling back to the distinct snapshot values. The Dashboard groups the Stage chip by pipeline
  and reads "Deal Stage" (`_hubspot` context); the Sales Stage numbering/Legacy split stays Salesforce-only. TCE
  (`/revenue/cost-per-acv`) By Account reads the Company from the snapshot on HubSpot instead of a live Salesforce
  query. Nudges were already CRM-neutral; only the "SF sync failed" trigger label gets a HubSpot wording.
- **HubSpot notes push, Support Tickets, CRM Sync** *(v1.394+, HubSpot phase 4)* — **Notes push**: the activity
  drawer's Post: Opp/Acct Notes checkboxes and My Notes' Push button reuse `activity_note_pushes` rows; `enqueuePush()`
  moved to `services/crm/notePush.ts` and hands the row to the active provider's `queueNotePush()`. On HubSpot
  (`services/hubspot/notesPush.ts`, job `hubspot_notes_push_worker`, 30s, run row only when something was pushed) it
  creates a note (`hs_note_body` = the "ImpactIQ: {type} - {title}" line + the Markdown as HTML, owner = the author's
  matched HubSpot owner) and associates it to the Deal (Opportunity target) or Company (Account target); if the
  association fails the note is deleted again so no orphan is left. `sf_content_note_id` holds the HubSpot note id and
  every attempt lands in `activity_sync_audit` (`source: 'note_push'`), so CRM Sync and its Retry work unchanged. A
  Salesforce target id is never sent. **Support Tickets** (`services/hubspot/tickets.ts`): `GET /api/crm/tickets/search`
  and `/tickets/refresh` (`routes/crm.ts`, team-access checked, 409 unless HubSpot is the CRM) return the same row shape
  as the Salesforce routes. Works with no mapping: Subject/Date opened/Status/Description/Owner read HubSpot's standard
  ticket properties, the ticket number is the record id, Contact is the primary associated contact, Status shows the
  pipeline stage label, and closed means a stage whose metadata `ticketState` is CLOSED (pipelines read once an hour),
  so no closed-status values are configured. A `ticket_*` mapping on the `tickets` object replaces a default. Default
  view is the linked Company's tickets (`associations.company`), Open Search searches every ticket by text. Under
  HubSpot the admin Ticket picker form only takes a label (config `{sobject: 'tickets'}`), and the ticket number links
  to `https://{uiDomain}/contacts/{portalId}/record/0-5/{id}` (`hubspotRecordLinkBase()`, sent as `recordLinkBase` by
  `GET /api/crm/provider`). **Deleting** an activity (and the Outlook-deleted purge) deletes its HubSpot meeting/task
  (`deleteHubspotEngagement()`, 404 counts as gone; a failure never blocks the local delete). **CRM Sync**: Issues
  explain HubSpot errors with their own classifier (`classifyHubspot()` in `SyncIssues.tsx`: scope, token, rate limit,
  association, deleted record, no HubSpot link, wrong CRM, mapping), and CRM Sync, sync pills, the anomaly panel, the
  delete confirm and the notes push labels read "HubSpot" via the `_hubspot` i18next context.
- **HubSpot wording + AI link suggestions** *(v1.395+)* — the strings a HubSpot install still read as "Salesforce" (activity form link label, Marketing hint, attendee/meeting-owner search, hover preview, Outlook-only and deleted-meeting texts, My Notes' AI link button, Admin → Activity Types' extras) have `_hubspot` i18next variants. The hover preview's open link points at the HubSpot record (`useCrmRecordLinkBase()` + `HUBSPOT_OBJECT_TYPE_IDS`). `POST /api/ai/link-suggestions` (`routes/ai.ts`) searches Deals/Companies/Campaigns through the provider session on HubSpot (open Deals only, at most 5 phrases; 401 `errors.crm.not_connected` with no session) and never touches Salesforce. Admin → Activity Types offers only the Ticket picker (and the CriteriaIQ Project picker) on HubSpot, since Opp field and the Salesforce related picker read Salesforce.
- **HubSpot Campaigns + Leads availability** *(v1.396+, HubSpot phase 5)* — the Campaigns/Leads switches now apply as `getEffectiveCrmFeatures()` (`services/crm/features.ts`): the admin's switch AND what the CRM offers (`getCrmFeatureAvailability()`; only HubSpot can lack one, when the last access check marked `campaigns_read`/`leads_read` missing; unknown or never checked counts as available). `GET /api/crm/features`, the `/api/crm/search/{leads,campaigns}` gates, activity saves (`crmLinkBlockError()`), the account drill and AI link suggestions use it; only Admin → CRM features reads the raw switches and shows an amber note when a switch is on but the portal lacks the feature (`meta.availability`). A refusal says `errors.crm.{campaigns,leads}_unavailable` when the switch is on and the portal is the reason, `_disabled` when the admin turned it off. The account drill's Include All on HubSpot takes Leads from `sf_lead_account_link` (filled by `refresh_hubspot_snapshots`) and has no Campaign bucket: HubSpot documents no Deal → Campaign association like Opportunity.CampaignId. **Campaign write-back**: a meeting whose What is a HubSpot campaign (a UUID, `HUBSPOT_CAMPAIGN_ID_RX` in `src/shared/hubspot.ts`; campaigns are the one HubSpot record not named by a numeric id) is added to it as a `MEETING_EVENT` campaign asset (`PUT /marketing/v3/campaigns/{guid}/assets/MEETING_EVENT/{meetingId}`, 409 counts as done) after its associations; a refusal parks the row like an association failure. A Campaign alone is enough to sync a meeting. HubSpot has no task asset type, so a task linked only to a Campaign is skipped with its own CRM Sync reason (`hs_campaign_task`), and a task with other links syncs without it. A new optional `campaigns_write` capability (`marketing.campaigns.write`) is probed by PATCHing the nil UUID. Unverified live: the test portal has no Marketing Hub. Not built: removing the meeting from an old campaign after a relink (the previous campaign isn't stored), an open-Lead filter on HubSpot Lead search (HubSpot documents no closed state for lead pipeline stages), and attendee-based Campaign suggestions on HubSpot (Salesforce's CampaignMember match has no documented HubSpot counterpart; HubSpot Campaigns search by name only).
- **HubSpot Assigned SE + ACV write-back** *(v1.397+, HubSpot phase 6a)* — `services/hubspot/dealFields.ts`. **Assigned SE**: `GET`/`PATCH /api/crm/opportunities/:id/assigned-se` and `GET /api/crm/picklists/opportunity/assigned-se` (`routes/crm.ts`, same shapes as the Salesforce routes, `?teamId=` checked against `getAccessibleTeamIds()`) read and write the Deal property the team maps as `assigned_se_write` on `deals` (writable direction). There is no fallback property: unmapped, `meta.configured` is false and the form hides the picker. The property's type decides the picker: a "HubSpot user" property (`referencedObjectType: 'OWNER'`) lists active `hubspot_owners` (matched to ImpactIQ users by email), an enumeration lists its options (matched by display name, like Salesforce picklists), plain text takes what was typed. A write needs the user to match an active HubSpot owner by email (`canWriteHubspotDeals()`, 403 `errors.hubspot.no_owner_match`): ImpactIQ writes with the portal-wide key, so this stands in for Salesforce checking the user's own record access; the form shows the value read only with a note (`meta.canWrite`). An owner/option value outside the list is 400 `errors.hubspot.assigned_se_invalid`; every write is logged to CRM Sync History (`assigned_se_update`, object `deals`). **ACV**: after a meeting/task syncs, `activities.acv` is PATCHed onto the first linked Deal through the team's writable `acv` deal mapping (`writeHubspotDealAcv()`); no mapping, no write, same as Salesforce since v1.296. A refusal is logged and kept in the sync audit payload as `acvError` but doesn't fail the activity's sync. Validate & dry run: `HUBSPOT_DEAL_WRITE_APP_FIELDS` (`acv`, `assigned_se_write`) get the read-only/calculated property check when writable, and an info `hubspot_deal_write_off` when set to read.
- **HubSpot Projects (Evaluations)** *(v1.398+, HubSpot phase 6b)* — `services/hubspot/projects.ts`. A team's Project
  object is HubSpot's standard Projects object (`0-970`) or an Enterprise custom object (`2-…`), named by its object type
  id (`HUBSPOT_PROJECT_OBJECT_RX`, `isHubspotProjectObject()` in `src/shared/hubspot.ts`). That id is the
  `related_object_picker` Extra's `sobject` (Admin → Activity Types offers the portal's Project objects from
  `GET /api/admin/hubspot/project-objects`, `labelField` = the object's primaryDisplayProperty), the stored
  `activities.sf_related_type`, and the `sf_object` of the team's `eval_*` mappings (Admin → HubSpot Field Mappings lists
  the Project objects beside meetings/tasks/deals; app fields `HUBSPOT_PROJECT_APP_FIELDS`). Nothing assumes a property
  name except the standard object's `hs_name` label. **Routes** (`routes/crm.ts`, all behind `requireCrmProjects()` and
  the HubSpot CRM, `?teamId=` checked against `getAccessibleTeamIds()`): `GET /opportunities/:id/related` lists the Deal's
  associated Project records (v4 associations); `GET /evaluations/:relatedId` returns raw values in `data` and display
  labels in `meta.labels` (`{unmapped: true}` when nothing is mapped); `GET /evaluations/picklist-values` the options of a
  mapped enumeration; `PATCH /evaluations/:relatedId` writes the editable fields (`HUBSPOT_PROJECT_EDITABLE_APP_FIELDS`,
  dates as HubSpot dates) and mirrors them into the activities' `sf_eval_*` snapshot; `GET /field-prepend/meta` and
  `POST /field-prepend` post a dated, initialed entry above Engineer Notes / Next Steps (same `MM/DD/YY - XX:` format and
  user-timezone date as Salesforce), only onto a writable plain string property (text/textarea, never html), capped at
  `HUBSPOT_STRING_MAX` (65,536), with a 409 `errors.hubspot.field_changed` when `hs_lastmodifieddate` moved since the
  form read it. Writes and posts need `canWriteHubspotDeals()` (403 `errors.hubspot.no_owner_match_record`) and are
  logged to CRM Sync History. Client: `EvalFieldsPanel`, `SfFieldPrependPanel`, the related picker, `ProjectMatchChip`
  and the Project hover preview call `useCrmApiBase()`/`crmApiBase()`. **Save**: `checkProjectLink()` reads a new HubSpot
  Project link's snapshot through the mappings (best effort; HubSpot down never blocks the save). **Nightly**:
  `refresh_hubspot_snapshots` also refreshes linked Projects (batch reads per object) and sets `sf_related_deleted` only
  for a record HubSpot no longer returns; a failed batch writes nothing; skipped unless Projects come from the CRM.
  Access check gains optional `projects_read`/`projects_write` (`crm.objects.projects.read`/`.write`). Validate & dry run:
  Project objects get static + property checks (`hubspot_not_prependable`, `hubspot_project_read_only`,
  `hubspot_project_write_off`) and a `hubspot_project_no_dry_run` note.
- **HubSpot link health, Relink and merges** *(v1.399+, HubSpot phase 7a)* — `services/hubspot/linkHealth.ts`. Job
  `hubspot_detect_disconnected_links` (24h, Admin → Scheduling, no run row unless HubSpot is the active CRM and connected)
  batch-reads every distinct linked id per slot (What → deals/companies, Who → contacts/leads, Related → the Project
  object; Campaigns and non-`HUBSPOT_ID_RX` ids are never sent; Leads skipped when the access check marks them missing)
  and sets the same `sf_what_deleted`/`sf_who_deleted`/`sf_related_deleted` flags as Salesforce. **Only an id HubSpot
  answers `OBJECT_NOT_FOUND` for (batch read 207, `errors[].context.ids`) is flagged**; a failed batch writes nothing and a
  401 stops the run. **Merges**: HubSpot answers a merged-away id with the surviving record (old ids in
  `hs_merged_object_ids`, checked live), so `resolveHubspotRecords()` maps old → survivor and `repointMergedLinks()` moves
  every activity on the old id (plus `sf_account_id` for a merged Company and `opp_review_dismissals` for a merged Deal),
  clears the flag, and writes a system audit row `activity.crm_merge_relink`. The nightly Deal and Project refreshes use
  the same resolution, so a merged Deal's snapshot follows the survivor. **Drawer**: `GET /api/crm/activity-link-status`
  (`routes/crm.ts`, owner or team access) runs the same check per link with the calling session and returns the row's
  flags plus `meta.moved` when a merge moved a link, which the form applies to its own state so saving doesn't move it
  back. **Relink** (`POST /api/activities/relink-opportunity`) has a HubSpot branch reading the target Deal with
  `readHubspotDealForRelink()` (a merged target links the survivor) and re-queuing synced meetings/tasks; errors use
  `_hubspot` keys. Activities Disconnected, Closed Lost: Needs Review and the SF Activities modal read Deal/Company
  wording via the `_hubspot` context and link to HubSpot records.
- **HubSpot attendees, Attach Rate and Sales Team Alignment** *(v1.400+, HubSpot phase 7b)* — **Attendees**:
  `CrmUserSession.suggestFromAttendees(emails)` replaces the Salesforce-only attendee lookups;
  `services/hubspot/attendees.ts` finds Contacts by email (lowercased, exact `IN`, max 100), then their primary Company
  and open Deals (closed from `hs_is_closed`, else stage metadata), in the Salesforce result shapes. CRM-neutral routes
  `GET /api/crm/search/from-attendees`, `POST /api/crm/suggestions/by-attendees` (internal domains dropped) and
  `GET /api/crm/accounts/:id/contacts?kind=` (a Company's Contacts by `associatedcompanyid`, a Deal's through its
  primary Company); the calendar suggestion batch goes through the provider too. **Attach Rate**:
  `services/hubspot/attachCoverage.ts`, job `refresh_hubspot_opp_coverage` (24h, no run row unless HubSpot is the CRM),
  fills `sf_opportunity_coverage` from Deals open or created/closed in the lookback, paged by `hs_object_id GT` (never the
  10k `after` cap); `attach_rate_fields` rows on `deals` or the Project object, values stored as names (owner → matched
  ImpactIQ user's name, else owner name; enumerations → labels); stale rows dropped only after a clean scan. The primary
  "Assigned SE" key is the team's `assigned_se_write`/`assigned_se_name` `deals` mapping. Shared upsert/cull/history
  helpers are factored out of `refreshOppCoverage.ts`. **Sales Team Alignment**: `syncHubspotOwners()` also copies
  owners into `sf_users` under their owner id (archived or gone → inactive, never deleted, since alignments cascade);
  `GET /api/admin/sf-users` lists only the active CRM's rows (`HUBSPOT_OWNER_ROW_RX`, 1–14 digits) and the refresh button
  syncs HubSpot owners. Sales Team Breakdown reads Deal/Company owners live via `hubspotRecordOwners()`. HubSpot has no
  reporting lines, so the Manager pivot groups everything under Unassigned; reps go under Owners.
- **HubSpot historical import** *(v1.401+, HubSpot phase 8a)* — the Salesforce Event backfill (§9 "Historical Activity
  Import") now runs on HubSpot too. The walker, state, exclusions, Relink, settings and every history screen are shared;
  only fetching a slice differs. `backfill.ts`'s `makeIngestor()` picks the slice reader by CRM (HubSpot loaded
  dynamically), and the table writes moved to `services/salesforce/historical/store.ts` (`writeHistoricalEvents`,
  `upsertHistoricalOpportunities`, `insertHistoricalAccounts`, `filterUnknownIds`, `SliceStats`) so both CRMs fill the same
  `sf_historical_*` tables. `services/hubspot/historical.ts`: a slice is meetings with `hs_timestamp` inside it, read with
  the search API paged by `hs_object_id GT lastId` ascending (200 a page), so a slice past HubSpot's 10,000-result cap
  still reads in full. Kept: meetings associated with a Deal, a Company or a configured Project object; skipped: no such
  link, or the meeting's id is already an `activities.sf_record_id` (ImpactIQ wrote it). What is the Deal, else the
  Project record, else the Company; Account is the meeting's Company, else the Deal's primary Company; Who is the first
  contact. Type is the first meeting property mapped as `activity_type` with a value, else `hs_activity_type`. Owner is
  `hubspot_owner_id` (matched to users through the owner copy in `sf_users`). Created By (`createdByKey()`) is the owner
  of the HubSpot user who created it, else `user:<id>`, else `source:<hs_object_source_id>` for an app; exclusion rules
  take those values (`HUBSPOT_HISTORICAL_ACTOR_RX`, `src/shared/hubspot.ts`; `POST .../exclusions` answers 400
  `errors.historical.invalid_hubspot_actor_id` on HubSpot). A meeting 24 hours or longer counts as all-day so the cap
  applies. Notes HTML becomes plain text. Deals/Companies get detail rows (stage and forecast labels, mapped `acv`, primary
  Company, industry label); closed Deals freeze at once. `refresh_historical_opps` runs `refreshHubspotHistoricalDeals()`
  on HubSpot (open Deals with HubSpot ids only, 100 a batch). `/api/history/me` matches the user through
  `getHubspotOwnerIdForUser()`. The exclusions search reads `GET /api/admin/sf-users` (lists the active CRM's people).
  Screens read HubSpot wording via the `_hubspot` i18next context. Not live-run end to end: the slice search and
  association reads were checked on test portal 247756533.
- **Historical import scope: meetings only** *(decided 2026-10-23, the owner)* — the HubSpot historical import brings in
  meetings and nothing else: no calls, emails, tasks or notes. It mirrors the Salesforce import, which reads Events only,
  and meetings are the one engagement type that maps cleanly to logged SE time (a start, an end and attendees). Calls
  and emails would inflate the history with short or zero-length touches, and tasks have no duration to estimate from.
  Revisit only with a concrete reporting need; widening it means a type map for each engagement kind and its own hours
  estimate. Smoke step: `docs/hubspot-production-smoke.md` §8.
- **HubSpot MCP tools** *(v1.402+, HubSpot phase 8b)* — the MCP server's CRM tools go through the active provider
  (`services/crm/mcpTools.ts`), so they work on Salesforce and HubSpot alike: `crm.search_opportunities` (the caller's
  own Opportunities/Deals, open unless `includeClosed`, team mappings from the caller's default team if they can access
  it), `crm.search_accounts` and `crm.get_record` (the hover preview's live read; an id that isn't this CRM's record id
  is refused before any session is opened). `salesforce.search_opportunities` stays as a deprecated alias. Results are
  `{crm, data, count?, error?}`; errors are `crm_not_configured`, `crm_not_connected`, `invalid_record_id`,
  `not_found` or the CRM's own error code. The alias's old `sf_not_connected` / `crm_provider_mismatch` errors became the codes above
  (documented in `docs/mcp.md`). Never the admin Salesforce connection.
- **CRM name in every string** *(v1.403+)* — strings never hardcode "Salesforce"/"SF" for the CRM: they use the
  i18next default variables `{{crm}}` (Salesforce / HubSpot / CRM) and `{{crmShort}}` (SF / HubSpot / CRM), from
  `CRM_DISPLAY_NAMES` / `crmWordingVariables()` (`src/shared/crmProvider.ts`). `applyCrmWording()` (`client/i18n/index.ts`)
  sets them from the active CRM and re-renders (emits `languageChanged`); the CRM store calls it when the provider loads,
  and `PageShell` loads it on every page. A new CRM only needs a `CRM_DISPLAY_NAMES` row. Context variants
  (`_hubspot`) stay only where wording differs beyond the name (Deal/Company, meeting/task, scopes); pure name swaps were
  removed. Strings that are about Salesforce itself keep the literal name: Salesforce connection/OAuth/admin-connection
  texts, Setup, `errors.salesforce.*`, the SF object list hints, SF Id formats in historical exclusions.
  `src/shared/crmWording.test.ts` checks the runtime mechanism and that every locale uses the variables wherever English does.
- **CRM Field Mappings toggle** *(v1.404+)* — Admin → CRM Field Mappings (`SfFieldMappings.tsx`) has a Salesforce /
  HubSpot toggle that starts on the active CRM (Salesforce when none is active). Each CRM keeps its own rows in
  `sf_field_mappings` (told apart by `isHubspotMappingTarget()`); the toggle picks which rows to list, add and edit, and an
  amber note says when the shown CRM isn't the active one. Wording on the page follows the toggle through
  `useCrmViewTranslation(crm)` (`store/crmProvider.ts`: `{{crm}}`/`{{crmShort}}` and the label context for that CRM).
  `POST .../sf-field-mappings/validate` takes `{crm}` in the body (else the active CRM) and runs that CRM's validator;
  Sample record already chose by object. Mapping create/edit never checked the CRM, so nothing else changed server-side.
  Tests: `routes/sfMappingValidate.routes.test.ts`.
- **Activity Types extras follow the CRM** *(v1.405+)* — `src/shared/crmExtras.ts`'s `activityTypeExtraCrm()` says
  which CRM an extra reads: an Opp field is HubSpot when its config `sobject` is `deals` (else Salesforce), a related picker
  is HubSpot for a HubSpot Project object (else Salesforce), and the Ticket picker and the CriteriaIQ Project picker work on
  any CRM. `GET /api/activities/sf-extras/:typeId` drops extras for the other CRM (`isActivityTypeExtraShownOn()`), so a
  Salesforce Opp field never reads a Deal; nothing is deleted, and Admin → Activity Types shows them dimmed with an "only on
  {{other}}" badge. **Opp field on HubSpot**: the admin form picks a Deal property from `GET /api/admin/hubspot/properties?
  object=deals` (open to any admin for `deals`, App Admin for other objects) and stores `{sobject: 'deals', apiName, label,
  fieldType, mode}`. The activity form reads it through `GET /api/crm/opportunities/:id/field?apiName=` (value, label,
  options, writable) and saves through `PATCH` on the same path (`services/hubspot/dealFields.ts`:
  `readHubspotDealField()`, `writeHubspotDealField()`). A write needs a matched HubSpot owner and a `read_write` Opp field
  extra on that property on one of the user's teams (`isEditableDealFieldExtra()`), since ImpactIQ writes with the
  portal-wide key; read-only/calculated properties, non-numbers and unknown options are refused before HubSpot is called,
  and every write is logged to CRM Sync History (`opportunity_field_update`, object `deals`). Enumeration properties show a
  dropdown of their options. Also fixed: `GET`/`POST /api/admin/teams/:teamId/activity-types/:typeId/sf-extras` didn't check
  that the type belongs to that team (`activityTypeVisibleToTeam()`, home team or junction). Tests:
  `hubspot/dealFieldExtras.test.ts`, `shared/crmExtras.test.ts`.
- **Team Management, User Management and the CRM user link follow the CRM** *(v1.406+)* — on HubSpot, `users.sf_user_id`
  can hold a HubSpot owner id set by hand in User Management (the owner copy in `sf_users`, §9 phase 7b). One SQL rule,
  `userIsHubspotOwner` (`services/hubspot/owners.ts`), decides which user an owner stands for everywhere
  (`getHubspotOwnerIdForUser()`, `getUserForHubspotOwner()`, the Assigned SE option list, Attach Rate owner names, the
  match summary): a manual link wins; otherwise the emails match, as long as the user isn't linked to another owner and
  no other user is linked to this owner, so one owner never resolves to two people. A leftover Salesforce id on the user
  doesn't block the email match. `hubspot_owners.teams` (migration 0157, jsonb `[{id, name, primary}]`) stores the teams
  the owners list returns (only for an owner on a team; built from HubSpot's docs, the test portal has no teams).
  Admin routes on HubSpot: `GET /api/admin/sf/users` lists active owner rows (Refresh re-syncs owners, 502 with the
  HubSpot error code on failure) and the Salesforce branch now leaves owner rows out; `GET /users/by-sf/:id` resolves an
  owner to its user; `GET /users/:userId/sf-details` returns the owner's team names (`teams`) instead of Title/Manager;
  `GET /sf/departments` lists distinct team names of active owners (`listHubspotTeamNames()`), so a team's "departments"
  are HubSpot teams. Team Management's Team Manager picker searches `/api/admin/sf/users` on HubSpot (Salesforce search
  stays on Salesforce). Wording on both pages, Activity Types' Type value fields and Historical Import / History
  (`_hubspot`: Meetings, Companies) follows the CRM; about 60 keys on these pages that only had English fallbacks now
  exist in all 7 locales, including `admin.users.mfa_codes_remaining_one/_other`, which had no text at all and showed the
  raw key. Tests: `hubspot/owners.test.ts` (manual link, teams), `routes/crmPeople.routes.test.ts`.
