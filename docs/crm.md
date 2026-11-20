# CRM integration: Salesforce, HubSpot, and adding more

ImpactIQ links logged activity to records in **one** CRM per install. Today that CRM can be
**Salesforce**, **HubSpot**, or **none**. The choice is install-wide (never two CRMs at once) and
every CRM sits behind the same provider interface, so a future CRM is a new provider rather than
a rewrite.

This page covers how the CRM is chosen, how to set up each one, what works where, and what it
takes to add another CRM. CLAUDE.md §9 holds the full design notes and version history.

---

## 1. Choosing the CRM

The CRM is chosen in two places, which write the same setting (`system_settings` key
`crm_provider`):

- **Setup wizard, step 6 ("CRM")** on a fresh install: Salesforce, HubSpot, or None.
  Salesforce takes its Connected App details on that step; HubSpot is connected after setup
  (step 6 says so), since it only needs a key pasted into Admin → Integrations.
- **Admin → Integrations → CRM** (App Admin) at any time afterwards.

Rules:

- **Default is Salesforce.** An install that predates the setting, or whose stored value is
  unreadable, behaves as Salesforce, so nothing switches off by accident.
- **Any CRM can be chosen before its connection is saved** (v1.407+). The card shows an amber
  "not set up yet" warning instead of refusing. Until the connection exists, that CRM's routes
  answer "not configured" and its background jobs stand down.
- **The lock.** Record ids don't carry across CRMs. Once anything links to CRM records (an
  activity with a What/Who/Related id or a write-back record id, an attached ticket, or an
  imported historical event), the only allowed moves are between the CRM those links came from
  and **None**. Anything else is refused with `errors.crm.provider_locked`. Switching to None and
  back is always safe: nothing is deleted. There is no way yet to clear or move those links, so an
  install that already links to Salesforce can't move to HubSpot (see §3.5 and the roadmap).
  On Admin → Integrations the CRM card shows a **Locked** pill and says which CRM can't be chosen,
  and that CRM's connection card shows it can't be used on this install instead of a setup form
  (v1.429+). A saved connection alone never locks; only the first CRM-linked record does.
- **None** turns every CRM read, write and job off. Saved links stay in the database.

Both the Salesforce and HubSpot connection cards are always listed on Admin → Integrations, with
a note inside whichever one isn't the chosen CRM, so the other CRM's connection can be prepared
ahead of a switch.

## 2. Salesforce

- **Per-user OAuth** (authorization-code flow) through a Salesforce Connected App, plus an
  optional **admin connection** used for org-wide work (metadata checks, nightly snapshot
  refresh, historical import). Tokens are AES-256-GCM encrypted at rest.
- Configure via Setup step 6, Admin → Integrations → Salesforce, or the `SF_CLIENT_ID` /
  `SF_CLIENT_SECRET` / `SF_REDIRECT_URI` / `SF_LOGIN_URL` env vars (the admin UI wins over env).
  `loginUrl` must be a `*.salesforce.com` / `*.force.com` HTTPS host.
- Activities write back as **Events or Tasks** (per activity type), asynchronously, with retry.
- Every field name comes from **CRM Field Mappings** (Admin, per team), never from code.

## 3. HubSpot

### 3.1 Connect

1. In HubSpot, create a **service key** (Development → Keys → Service Keys, recommended) or a
   **private app access token** for the portal. Grant the scopes below.
2. In ImpactIQ, open **Admin → Integrations → HubSpot**, paste the key, and save. ImpactIQ checks
   it with HubSpot before storing it (encrypted) and records the portal id and name.
3. Click **Check access**. ImpactIQ probes each capability without creating or changing data and
   lists what is available, what is missing, and the scope that would grant it.
4. Click **Sync owners** (also runs daily as `hubspot_owner_sync`). This copies the portal's
   owners so ImpactIQ users can be matched to them.
5. Choose **HubSpot** on Admin → Integrations → CRM.

There is no OAuth and no per-user HubSpot login: one portal-wide key serves the whole install.
No environment variables are involved; HubSpot is configured only in the app.

### 3.2 Scopes

Required:

| Capability | Scope |
|---|---|
| Read Deals / Companies / Contacts | `crm.objects.deals.read`, `crm.objects.companies.read`, `crm.objects.contacts.read` |
| Read owners | `crm.objects.owners.read` |
| Read Deal / Company / Contact properties | `crm.schemas.deals.read`, `crm.schemas.companies.read`, `crm.schemas.contacts.read` |
| Write meetings and tasks | `crm.objects.contacts.write` |

Optional (features turn off on their own when missing): `crm.objects.deals.write` (Assigned SE
and ACV write-back, Deal field extras), `crm.objects.tickets.read` (Support Tickets),
`crm.objects.leads.read` (Leads), `marketing.campaigns.read` / `marketing.campaigns.write`
(Campaigns; needs Marketing Hub), `crm.schemas.custom.read` (custom objects as Projects),
`crm.objects.projects.read` / `crm.objects.projects.write` (HubSpot Projects).

The scope list shown on the card comes from `HUBSPOT_CAPABILITY_SCOPES` in
`src/shared/hubspot.ts`.

### 3.3 How people are matched

Because there is no per-user login, each ImpactIQ user is matched to a **HubSpot owner** by email
(case-insensitive, active owners only). An admin can override the match by linking a specific
owner in **User Management**. One owner never resolves to two people. Writes that act on a Deal
(Assigned SE, ACV, Deal field extras, Project edits) require the user to match an owner, since
ImpactIQ writes with the portal-wide key and this stands in for "does this person have access."

### 3.4 What works on HubSpot

| Area | HubSpot behavior |
|---|---|
| Search and linking | Deals, Companies, Contacts; Leads and Campaigns when the portal has them. "My Deals" uses the matched owner or a mapped SE property; Open Search drops the filter |
| Hover preview | Deal / Company, plus mapped Deal properties; links open the HubSpot record |
| Write-back | Activity type's object picks **meeting** (Event) or **task** (Task); associated to the Deal, its Company, the Who and attendee Contacts; retried on failure; deleting the activity deletes the engagement |
| Field mappings | Admin → CRM Field Mappings with a Salesforce / HubSpot toggle; live property pickers; Validate & dry run and Sample record |
| Nightly refresh | `refresh_hubspot_snapshots`: stage, forecast, amount, close date, owner, SE, Company, won/closed |
| Notes push | Activity drawer and My Notes push a note to the Deal or Company |
| Support Tickets | Works with no mapping (standard ticket properties; "closed" from pipeline stage metadata) |
| Projects (POC/POV) | HubSpot Projects object or an Enterprise custom object, chosen per activity type |
| Link health and merges | Deleted records are flagged; merged records move every activity to the surviving record automatically |
| Relink, attendees, Attach Rate, Sales Team Alignment, historical import, MCP tools | All supported |

### 3.5 Known limits

- **An existing Salesforce install can't switch to HubSpot.** The lock (§1) keeps a CRM in place
  once anything links to its records, and there is no tool yet to clear or move those links.
  HubSpot works on a new install, or on one that never linked anything to Salesforce. Moving an
  established install over is on the roadmap (CLAUDE.md §18, "CRM switch-over").
- HubSpot has no reporting lines, so the Sales Team Alignment **Manager** pivot groups everyone
  under Unassigned.
- HubSpot has no Deal → Campaign association, and no task campaign asset type, so a task linked
  only to a Campaign isn't synced (CRM Sync explains why).
- Lead search has no "open only" filter (HubSpot documents no closed state for lead stages).
- Leads, Campaigns and HubSpot Projects are built from HubSpot's documentation and capability-
  gated; they were not all verified against a live portal with those features.
- Rate limits are respected in-process (about 90 calls per 10 seconds, following HubSpot's
  headers); a daily-limit response stops the current job rather than retrying.

## 4. Optional CRM features

Admin → Integrations → **CRM features** has app-wide switches for **Campaigns** and **Leads**
(both on by default). A feature is available when the switch is on **and** the CRM offers it
(on HubSpot, when the last access check didn't mark it missing). Turning a switch off hides the
tab, refuses new links on the server, and keeps existing links untouched.

## 5. Projects (POC|POV) source

Admin → Integrations → **Projects (POC|POV)** picks where Projects come from: the **CRM object**
(Salesforce `Evaluations__c`-style object, or a HubSpot Projects/custom object), **CriteriaIQ**,
or **Off**. CriteriaIQ can also be a secondary panel beside the CRM object. The source is locked
once activities link to Projects. See CLAUDE.md §9.

## 6. Wording follows the CRM

UI strings never hardcode "Salesforce" or "SF". They use the i18next variables `{{crm}}` and
`{{crmShort}}`, filled from `CRM_DISPLAY_NAMES` in `src/shared/crmProvider.ts` (Salesforce / SF,
HubSpot / HubSpot, CRM / CRM for None). Where the terms themselves differ (Opportunity vs Deal,
Account vs Company, Event vs meeting), a `_<providerId>` context variant carries the different
wording (for example `sf.opportunity_hubspot` = "Deal").

Tables and columns that hold data for any CRM are named `crm_*` (`activities.crm_what_id`,
`crm_record_id`, `crm_field_mappings`, `crm_users`, `crm_historical_*`, `activity_crm_tickets`, …)
and hold whichever CRM's ids the install uses (renamed from `sf_*` in v1.411–v1.413, along with the
enum types, e.g. `crm_what_type`). Salesforce-only tables keep `sf_*` (`sf_event_type_config`,
`sf_user_names`, `sf_object_owner_cache`) and their columns.

## 7. Adding another CRM

The provider boundary is `services/crm/`. Routes, MCP tools, the activity save path and the
dashboard Refresh button ask the active provider for CRM work instead of calling a specific CRM.
To add a CRM (say `pipedrive`):

1. **Id and name** — add the id to `CRM_PROVIDER_IDS` and a row to `CRM_DISPLAY_NAMES`
   (`src/shared/crmProvider.ts`). Every `{{crm}}` / `{{crmShort}}` string picks the name up with no
   translation edits.
2. **Provider** — implement `CrmProvider` (`services/crm/types.ts`): `isRecordId`,
   `connectForUser` (returning a `CrmUserSession` with search, preview and attendee suggestions),
   `queueActivitySync`, `queueNotePush` and `refreshSnapshots`. Translate the CRM's objects to
   ImpactIQ's canonical kinds (Opportunity, Account, Contact, Lead, Campaign) at this boundary.
   Register it in `PROVIDERS` (`services/crm/index.ts`); from then on it is offered by
   `availableCrmProviderIds()`, Setup step 6 and Admin → Integrations → CRM.
3. **Connection** — a config service and an Admin → Integrations card (secrets encrypted with
   `encryptToken`, outbound URLs through the SSRF guard, every save/clear audited).
4. **Routes and jobs** — CRM-specific routes either live behind `requireCrmProvider('<id>')` or
   join the CRM-neutral `/api/crm/*` router; the client picks the base with `crmApiBaseFor()`.
   Every scheduled job returns quietly (no `job_runs` row) when its CRM isn't active.
5. **Feature availability** — report optional features (Leads, Campaigns, …) through
   `getCrmFeatureAvailability()` so the CRM features switches and refusals work unchanged.
6. **Field mappings** — mappings live in `crm_field_mappings` with the CRM's own object name in
   `crm_object`; add the CRM to the CRM Field Mappings toggle and give it a validator returning the
   shared `ValidationResult` shape.
7. **Wording** — add `_<id>` context variants only where terms differ beyond the name, in all
   seven locales (`python3 scripts/check-i18n-parity.py`).
8. **The lock** — extend `countCrmLinkedData()` if the CRM stores links anywhere new, and make
   sure no other CRM's code ever sends this CRM's ids (each provider checks `isRecordId`).

The HubSpot provider (`services/crm/hubspotProvider.ts`, `services/hubspot/`) is the worked
example; the Salesforce provider (`services/crm/salesforceProvider.ts`) is a thin adapter over
`services/salesforce/`.
