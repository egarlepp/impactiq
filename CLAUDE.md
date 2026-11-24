# CLAUDE.md — ImpactIQ Project Bible

> This file is the single source of truth for every Claude Code session on this project.
> Read this file completely before touching any code. All architectural decisions documented
> here are LOCKED unless explicitly overridden by the human in the current session.
>
> Long write-ups live in `docs/`: `docs/history.md` (every release), `docs/crm-providers.md` (CRM layer,
> HubSpot, CriteriaIQ), `docs/salesforce-details.md`, `docs/features.md`. Read the one for the area you touch.
>
> GitHub Repo: https://github.com/egarlepp/impactiq

---

## 1. Project Overview

**ImpactIQ** is a self-hosted tool that allows users to capture their technical
validation activities, link them to Salesforce Opportunities and Accounts, and surface
capacity planning data for team Leaders.

- **Primary user:** Contributor (SE, Channel, Sales rep, etc.) — logs what they did
- **Secondary user:** Team Leader — views team capacity and activity distribution
- **Tertiary user:** App Admin — configures the system, teams, rulesets, and SF mappings

**Design philosophy:** Contributor-first. If logging activities has friction, the leader
never gets clean data. Every UX decision optimizes for contributor adoption first.

**Positioning:** This is a *capacity planning tool*, not a performance review tool. This
distinction must be visible in the UI itself as a persistent contextual note on the
activity logging screen.

**Multi-team architecture:** ImpactIQ supports multiple named teams (e.g., Sales Engineering,
Channel, Sales). Each team has its own activity type configuration, AI/keyword rulesets,
SF field mappings, and capacity settings. A user belongs to one team. All configuration
is scoped to the team.

---

## 2. Tech Stack

### Critical Version Awareness
These are the EXACT versions in use. Do not substitute, upgrade, or assume compatibility
with adjacent versions without explicit human approval.

| Layer | Technology | Version |
|---|---|---|
| Frontend framework | React | 19 |
| Build tool | Vite | Latest compatible with React 19 |
| CSS framework | Tailwind CSS | 4 |
| Component library | shadcn/ui | Latest |
| Backend framework | Express | 5 |
| Language | TypeScript | 6 |
| Schema validation | Zod | 4 |
| ORM | Drizzle ORM | Latest |
| Database | Containerized Postgres | — |
| Auth | Okta OIDC (`@okta/okta-auth-js`) | Latest |
| Salesforce client | JSForce | v3 |
| Outlook/Calendar | Microsoft Graph API | v1.0 |
| AI | AI Assistant (admin's choice of provider, §14) | Anthropic / Azure OpenAI / OpenAI / Bedrock / Foundry / Gemini / xAI |
| i18n | react-i18next | Latest |
| Deployment | Docker + Dokploy | — |

### Database
Containerized Postgres only. No Neon. DATABASE_URL is the only connection config needed.

```env
DATABASE_URL=postgresql://user:password@postgres:5432/impactiq
```

---

## 3. Repository Structure

```
impactiq/
├── CLAUDE.md                     # This file — read first every session
├── PRD.md                        # Product requirements document
├── .env.example                  # All required env vars documented
├── docker-compose.yml            # Local dev + production compose
├── Dockerfile
├── drizzle/
│   ├── schema.ts                 # Single source of truth for DB schema
│   ├── migrations/               # Never modify existing migrations
│   └── seed.ts                   # Default data: teams, activity types, SF mappings, rules
├── src/
│   ├── client/                   # React frontend
│   │   ├── components/
│   │   │   ├── ui/               # shadcn/ui components (do not modify directly)
│   │   │   ├── activities/       # Activity logging components
│   │   │   ├── calendar/         # Outlook calendar integration components
│   │   │   ├── salesforce/       # SF lookup + write-back components
│   │   │   ├── leader/           # Leader dashboard components
│   │   │   └── admin/            # Admin configuration components
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── store/                # State management
│   │   ├── i18n/                 # Translations (en, de, fr, es, ja, pt, it)
│   │   └── lib/
│   ├── server/                   # Express backend
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── services/
│   │   │   ├── auth/             # Okta + SF OAuth token management
│   │   │   ├── outlook/          # Microsoft Graph API client
│   │   │   ├── salesforce/       # JSForce client + field mapping
│   │   │   ├── ai/               # Azure OpenAI classification service
│   │   │   └── nudge/            # Rules-based nudge engine
│   │   └── db/
│   └── shared/
│       └── schemas/              # Zod schemas shared between client and server
└── tests/
```

---

## 4. Authentication Architecture

### Primary Auth: Okta OIDC
- All users authenticate via Okta
- Okta federates to Microsoft 365 (Outlook calendar access via federated M365 token)
- MFA is enforced at the Okta layer — the app does not manage MFA
- Session managed via Okta JWT; validate on every API request server-side

### Salesforce OAuth
- Per-user OAuth 2.0 authorization code flow
- Refresh token stored server-side, encrypted at rest (AES-256)
- Silent re-auth using refresh token until token expires or is revoked
- Full SF OAuth re-prompt only on token expiry/revocation
- Store per user in `user_integrations` table:
  ```
  user_integrations(user_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at)
  ```

### Outlook / Microsoft Graph
- Access token derived from Okta-federated M365 token
- Scopes required: `Calendars.Read`, `User.Read`
- Token refresh handled transparently

### OAuth state cookie encryption *(v1.256.1+)*
The PKCE verifier + OIDC nonce cookie minted by both `/auth/okta` and `/auth/azure`
(short-lived, ~10 min) is AES-256-GCM encrypted via the same `encryptToken`/
`decryptToken` cipher in `services/config/crypto.ts` used for SF/MS refresh tokens
(`TOKEN_ENCRYPTION_KEY`) — previously it was plain `encodeURIComponent(JSON)` in an
HttpOnly/Secure-in-prod cookie, which CodeQL flagged as clear-text storage of
sensitive data. The verifier was already worthless without the matching
authorization code, so this is defense-in-depth reusing an existing cipher, not a
new trust boundary.

### Salesforce / Microsoft connect binding *(v1.423+)*
The Salesforce (user and admin) and Microsoft connect flows set an encrypted binding cookie
(`routes/auth/oauthBinding.ts`: nonce, user id, Salesforce PKCE verifier). The callback requires the signed state,
that cookie and the current session to name the same user and nonce. Keep the PKCE verifier out of the state (it's
in the URL). Sessions are opaque tokens in the `sessions` table only; the old HMAC cookie format is not accepted.

### Trusted proxies and HubSpot access *(v1.424+)*
`trust proxy` is `trustProxyHops` (`services/config/rate-limit-config.ts`): the number of proxies in front of the app,
set on Admin → Integrations → Rate Limiting (0–3, default 0) or by `TRUSTED_PROXY_HOPS`. Never set it back to `true`;
the per-IP limits would key on a client-supplied header. HubSpot uses one portal-wide key, so ImpactIQ is the gate: no
HubSpot session for a user not matched to an active owner, notes post only to the activity's own records, and Deal
edits follow `canEditHubspotDeal()` (`services/hubspot/dealEditPolicy.ts`, Admin → Integrations → HubSpot → Who can
edit Deals). Check it in any new route that writes to a Deal.

### Disabled accounts and the setup token *(v1.425+)*
An App Admin can disable a user (`users.disabled_at`, `services/auth/userStatus.ts`): it revokes their sessions and API
keys, and `requireAuth`, `verifyApiKey()` and every sign-in path refuse the account. A new sign-in path must check
`isUserDisabled()` too. In setup mode every `/api/setup` route but `GET /status` needs the `X-Setup-Token` header (a
token printed to the server log at startup, or `SETUP_TOKEN`). *(v1.475+)* With `DATABASE_URL` set but no user yet, the
server prints the same token and the sign-in page offers **Create the first admin** (`/api/first-run`,
`services/auth/firstRun.ts`): token required, refused for good once any user exists (re-checked under an advisory lock),
and the account is App Admin and default admin. A refused Okta/Azure sign-in redirects with a reason key
from `src/shared/ssoErrors.ts` (v1.427.1+), which the Login page shows; add any new reason to that list and the locales.

### Sign-in Method (`users.auth_method`) *(v1.323+)*
Four values: `password` | `okta` | `azure` | `both`. Exactly one of `password`/`okta`/`azure`
means that IdP (or local password) is the account's ONLY valid sign-in path — the other two are
rejected at their respective callback/login route. `both` means "All Login Options" (its label
in User Management's Sign-in Method dropdown — historically labeled "Password or Okta" back when
Azure wasn't a distinct choice): password, Okta, AND Azure are all valid. Shared helpers
`authMethodNeedsPassword()` / `authMethodAllowsOkta()` / `authMethodAllowsAzure()`
(`src/shared/schemas/password.ts`) are the single source of truth for this logic — used by both
the password-login route, the Okta/Azure callback blocking checks, and the client's
create/edit-user forms' password-field visibility. Never hardcode `authMethod === 'okta'` (or
similar) inline; a new SSO provider added later needs the same three-way exclusivity every
existing one already has.

### Password reuse + 90-day expiry policy *(v1.323+)*
Scoped ENTIRELY to accounts whose `authMethod` is exactly `'password'` — Okta/Azure SSO accounts,
and `'both'` accounts (password is only one of several valid ways in for those), are completely
exempt. This is deliberate: forcing a password-expiry gate onto a `'both'` account would also
block their SSO-driven access, since `requireAuth`'s `mustChangePassword` check is unconditional
regardless of how the session was established.

- **Reuse** — `services/auth/passwordPolicy.ts`'s `setUserPassword()` is the single entry point
  for every password-write code path (self-service change, forgot-password reset, admin reset —
  NOT initial account creation, which has no history yet). Rejects a new password that matches
  the current hash or any of the last `PASSWORD_HISTORY_LIMIT - 1` (4) rows in `password_history`,
  re-deriving the target's own `authMethod` server-side rather than trusting a caller flag, so the
  check can never be silently skipped. A successful change moves the just-superseded hash into
  history and prunes it back down to that count, all inside one transaction.
- **Expiry** — `users.password_changed_at`, stamped on every password write. A daily
  `password_expiry_enforcement` job (`services/auth/passwordExpiry.ts`, Admin → Scheduling)
  flags any `authMethod='password'` account whose password has passed `PASSWORD_EXPIRY_DAYS` (90)
  by setting the SAME `mustChangePassword` flag the first-login forced-change flow already uses —
  no new gate or UI needed anywhere; `requireAuth` already blocks a non-allowlisted request once
  it's true, and Login.tsx already renders the change-password screen for it.
- **Rollout backfill** (migration 0142) — every EXISTING password-holding account gets
  `password_changed_at = now()` at deploy time rather than backdating to `created_at`. There's no
  real record of when a password was actually last changed, and backdating would immediately
  expire long-lived accounts on rollout day — starting the clock fresh is the kinder default.
- **User Management** shows a Password Reset countdown pill per user (`in {{n}}d` / `{{n}}d
  overdue`, red when overdue) — `—` for any non-`'password'` account, since the policy doesn't
  apply to them.

### NEVER:
- Store plaintext tokens anywhere
- Log tokens in application logs
- Expose tokens to the frontend

---

## 5. RBAC Model

Four roles. Enforced server-side on every API endpoint — never trust frontend role claims. Roles are scoped within a team; a user can have different roles on different teams (e.g. Team Admin on Sales Engineering, Contributor on Channel). App Admin is a global flag on `users.is_app_admin`, independent of team membership.

### Contributor
- Log, view, and edit their own activities (free edit within 90 days of creation)
- Read-only after 90 days
- View ALL finalized activities across their team
- Cannot view other contributors' draft/unsubmitted activities
- Cannot access leader dashboards or admin screens

### Team Leader
- View finalized activities for their assigned team(s)
- Access all leader dashboards (see §13) for teams they lead
- Cannot edit contributor activity records
- Cannot access admin configuration screens
- Global-teams flag (`users.can_see_all_teams`) can widen scope to all teams

**Shared checks** *(v1.422+)*: a single activity is readable per `canViewActivity()` (`services/activities/access.ts`) — owner, App Admin, an admin/team_admin over the owner, else submitted-only for anyone who can see its team. A request names one team: `requestTeamId()` (`middleware/rbac.ts`) rejects params/body/query that disagree, and GET bodies are never parsed. Use both in any new route instead of an ad hoc check.

### Team Admin
- All Team Leader access on their team(s), plus:
- Configure team-scoped activity types, keyword rules, nudge rules, capacity/cost groups, and user role assignments *within their team*
- Cannot create/delete teams, edit theming, or manage SF field mappings globally
- Cannot see other teams' rows unless granted `can_see_all_teams`

### App Admin (`users.is_app_admin = true`)
- Full access to all teams and all admin screens
- Manages teams, themes, integrations, role permission matrix, monitoring pages (Audit Log, Sync History, Nudge History, Scheduling)
- Can stack any team-scoped role

---

## 6. Multi-Team Architecture

### Teams
Each team is an independent configuration namespace. Teams are created and managed by App Admin.

```typescript
// drizzle/schema.ts
teams {
  id                uuid PRIMARY KEY
  name              text NOT NULL          // e.g., 'Sales Engineering', 'Channel', 'Sales'
  slug              text NOT NULL UNIQUE   // e.g., 'sales-engineering'
  description       text
  is_active         boolean DEFAULT true
  created_at        timestamptz DEFAULT now()
}
```

### Team Membership
```typescript
team_members {
  id          uuid PRIMARY KEY
  team_id     uuid REFERENCES teams(id)
  user_id     uuid REFERENCES users(id)
  role        enum('contributor', 'leader', 'admin')
  UNIQUE(team_id, user_id)
}
```

### Team-Scoped Configuration
All of the following are scoped to a team:
- Activity type definitions (which types are active, SF object type per activity)
- SF field mappings
- SF picklist allowed values
- Keyword rules for AI suggestion
- Nudge rules
- Capacity groups

**Seed data must create a default "Sales Engineering" team** with the full default
configuration so the app is functional on first install.

---

## 7. Activity Data Model

### Activity Types (Admin-configurable per team)
Default 10 types seeded for the Sales Engineering team. Admin can activate/deactivate
per team. Each activity type has an associated SF object type (Event or Task).

| Type | Default SF Object | Default Active |
|---|---|---|
| Demo | Event | true |
| Discovery | Event | true |
| Enablement | Event | true |
| Eval Work | Event | true |
| Executive Briefing | Event | true |
| HealthCheck | Event | true |
| Marketing | Event | true |
| Meeting | Event | true |
| RFx Work | Event | true |
| Support | Event | true |

### Activity Type Config Table
```typescript
team_activity_types {
  id              uuid PRIMARY KEY
  team_id         uuid REFERENCES teams(id)
  name            text NOT NULL           // e.g., 'Demo'
  sf_object_type  enum('Event', 'Task')   // Admin-configurable per type
  is_active       boolean DEFAULT true
  sort_order      int
  UNIQUE(team_id, name)
}
```

### SF Picklist Values in the Reference Org
The following values exist in the SF Event Type picklist. Seed these in `sf_event_type_config`:
```
Marketing | Discovery | Demo | Enablement | RFx Work | HealthCheck |
Executive Briefing | Support | Eval Work
```
NOTE *(corrected v1.214.0)*: **Meeting** IS now present and is in fact the most-used
Event Type in the reference org. The earlier note
here said it was missing and had to be added by the SF Admin — that is no longer true.
If a value is genuinely absent from the picklist, activities of that type sync with a
null/empty Type field or a configurable fallback value.

### Core Activity Record
```typescript
activities {
  id                  uuid PRIMARY KEY
  user_id             uuid REFERENCES users(id)
  team_id             uuid REFERENCES teams(id)
  title               text NOT NULL
  activity_type_id    uuid REFERENCES team_activity_types(id)
  status              enum('draft', 'submitted') DEFAULT 'draft'
  start_datetime      timestamptz NOT NULL
  end_datetime        timestamptz NOT NULL
  effort_hours        decimal(4,2) NOT NULL     // editable, pre-filled from duration
  notes               text
  outlook_event_id    text                      // internal dedup only, NEVER shown to user
  crm_what_id         text                      // Opportunity ID or Account ID
  crm_what_type       enum('Opportunity', 'Account')
  crm_what_name       text                      // denormalized display name
  crm_record_id       text                      // CRM record id (SF Event/Task, HubSpot meeting/task) after write-back
  crm_sync_status     enum('pending', 'synced', 'failed')
  crm_sync_error      text
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()
  is_archived         boolean DEFAULT false
}
```

*(v1.411+)* Every CRM column on `activities` is named `crm_*` (`crm_what_id`, `crm_who_id`, `crm_related_id`,
`crm_account_id`, `crm_eval_*`, `crm_sync_*`, `crm_is_closed`, ...; TypeScript `crmWhatId` etc.), renamed from `sf_*` by
migration 0159, along with `activity_sync_audit.crm_record_id`. Older text in this file still says `sf_what_id` and so on:
read those as the `crm_` names. The enum types `sf_what_type` / `sf_sync_status` keep their names until the last rename PR.

*(v1.412+)* Tables that hold data for any CRM are named `crm_*` too, renamed by migration 0160 (TypeScript exports
follow, e.g. `sfFieldMappings` → `crmFieldMappings`): `crm_field_mappings`, `crm_field_mapping_teams`, `crm_users`,
`crm_user_alignments`, `crm_opportunity_coverage`, `crm_snapshot_state`, `crm_lead_account_link`, the seven
`crm_historical_*` tables, `activity_crm_tickets` and `team_activity_type_crm_extras`. Older text here saying
`sf_field_mappings`, `sf_users`, `sf_historical_events`, `activity_sf_tickets`, `team_activity_type_sf_extras` and so on
means these. Salesforce-only tables keep `sf_*`: `sf_event_type_config`, `sf_user_names`, `sf_object_owner_cache`.
The audit action `sf_users.sync` (stored on existing audit rows) is unchanged.

*(v1.413+)* The remaining CRM columns and the enum types are `crm_*` as well (migration 0161), with their TypeScript
keys: `users.crm_user_id`, `teams.crm_departments`, `team_activity_types.crm_object_type` / `crm_picklist_value`,
`crm_field_mappings.crm_field_api` / `crm_object`, `activity_sync_audit.crm_object`, `attach_rate_fields.crm_object`,
`activity_crm_tickets.crm_ticket_id` (and its other `crm_*` snapshot columns), `activity_note_pushes.crm_target_*` /
`crm_content_note_id`, `outlook_events.suggested_crm_*` / `crm_suggestion_*` / `user_override_crm_what_*`,
`opp_review_dismissals.crm_opp_id` / `crm_opp_name`, `crm_field_mapping_teams.crm_field_mapping_id`,
`crm_user_alignments.crm_user_id`, `crm_historical_exclusions.crm_user_id`, `crm_historical_type_map.crm_type_value`,
`crm_historical_import_runs.crm_api_calls` and `crm_historical_events.crm_event_id` / `crm_type` /
`owner_crm_user_*` / `created_by_crm_user_*` / `crm_created_date` / `crm_system_modstamp`. Enum types:
`crm_object_type`, `crm_sync_status`, `crm_what_type`, `crm_alignment_role`. Older text here (and in `docs/`) with the
`sf_` forms means these. Kept as `sf_*`: the Salesforce-only tables and their columns
(`sf_event_type_config.sf_picklist_value`, `sf_user_names.sf_user_id`, `sf_object_owner_cache.sf_id`) and stored values
(enum value `sf_sync_failed`, `crm_historical_events.user_match_method = 'sf_user_id'`, audit action `sf_users.sync`).
Export files from before v1.413 still import: `renameLegacyKeys()` (`src/shared/legacyKeys.ts`) maps
`sfFieldApi`/`sfObject` and `sfObjectType`/`sfPicklistValue` to the new keys. Component and file names (`SfSearch`,
`services/salesforce/`, the `/api/salesforce` routes) were not part of the rename.

### Retention Rules
- Active records: 2 years from `created_at`
- Archived after 2 years — soft delete (`is_archived = true`), data retained indefinitely
- Contributor edits allowed within 90 days of `created_at`; read-only after
- **Sidebar version number under the app name (v1.379.4)** — copied from VectorIQ's `sidebar.tsx`: the wordmark and `VersionChip` stack in a right-aligned column (`flex-col items-end justify-between self-stretch`) beside the logo instead of sitting inline; the chip is `font-mono text-[9px] leading-none opacity-80` in the app-name color (it was 10px in the muted sidebar text color).
- Archival management UI is Phase 2

### Non-Activity Meetings

Outlook events a contributor is certain aren't work (1:1s, internal
syncs, personal blocks) can be marked as **Non-Activity** so they
disappear from the day list and render dark gray on the Outlook
calendar column. The flag is per-user and per-Outlook-event —
never team-wide.

```typescript
non_activity_events {
  user_id            uuid REFERENCES users(id) ON DELETE CASCADE
  outlook_event_id   text NOT NULL
  marked_at          timestamptz DEFAULT now()
  PRIMARY KEY (user_id, outlook_event_id)
}
```

Every team seeds an inactive `None` row in `team_activity_types`
(`is_active = false`, `sort_order = 999`, `color = '#6B7280'`).
It's the display anchor for Non-Activity cards — it MUST NOT
appear in the Log Activity type picker (filter by `is_active` in
the UI, don't hardcode a name check).

### Three ways a meeting becomes a Non-Activity

1. **Manually** — the contributor clicks Non-Activity on the card.
2. **A team keyword rule** *(v1.240+)* — `keyword_rules.action =
   'mark_non_activity'`. Team-scoped, admin-managed, applies to
   everyone on the team. See §11.
3. **The contributor's own keywords** *(v1.243+)* —
   `users.non_activity_keywords` (text[]), edited in My Settings →
   Data & Templates. Subject-substring, case-insensitive, applies to
   **that user only**. See §11 Layer 1.5.

All three converge on the same `non_activity_events` upsert, so all
three are equally reversible via Mark as Activity, and none of them
ever touch `activities`.

### "No Match" is NOT Non-Activity *(v1.241+)*

A meeting that matched no keyword rule, no AI classification, and has
no configured default type is **untyped**, not excluded. It renders a
white **No Match** pill, stays in the day list, and stays approvable
(Approve opens the Edit drawer so the contributor picks a type).

v1.240.0 briefly resolved this case to `mark_non_activity`, which
auto-hid those events behind the Show Non-Activities toggle — burying
precisely the meetings that most needed a human decision. Do not
re-conflate these two states. "None / Non-Activity" means *someone
decided this isn't work*; "No Match" means *nobody has decided yet*.

Behavior contract for Non-Activity cards and the Outlook event
details modal:
- Suggested-meeting card renders dark gray in both light and dark
  mode; type badge reads "None"; the corresponding calendar event
  paints dark gray so the two views agree.
- **Approve** / **Approve with template** / **Save Draft** /
  **Submit** are disabled with a tooltip pointing at Mark as
  Activity. Product pills are disabled the same way.
- The **Edit** drawer and the calendar event details modal show a
  gray banner at the top with a **Mark as Activity** button that
  flips the flag off in place.
- Show Non-Activities checkbox next to Log Activity defaults to
  **unchecked** (hidden). Toggling on reveals marked meetings so
  the user can flip them back.
- Marking never touches `activities` — it doesn't create rows;
  unmarking never restores lost work.

Storage caveats: outlookEventId strings vary in shape across
tenants (real Graph event IDs, `demo-outlook-*` fixtures). Never
parse or validate the format server-side beyond length; treat it
as an opaque per-user key.

### Evaluation terminology *(v1.446+)*

Admin → Workplace → Terminology (App Admin, `src/shared/terminology.ts`): Eval / POC / POV / POx / Project / Custom,
default POx, so the seeded evaluation type is "POx Work". Never hardcode "Eval Work": new-team defaults, seed.ts, Seed
Default Content and demo data resolve it with `evalWorkTypeName(await getTerminology())`, default lists stay keyed by
`LEGACY_EVAL_WORK_NAME` via `defaultTypeKey()`, and UI strings use `{{evalTerm}}` / `{{evalWork}}`. Installs that had
"Eval Work" were pinned to Eval (migration 0171). Changing the term renames exact-name types in one transaction and
gives a type with no CRM picklist override the old name as its override, so the CRM keeps getting the same Type value.

### Activity Type Guide page and per-type Guide fields *(v1.255+)*

A new sidebar page (all roles) reads `team_activity_types.use_this_when` /
`usually_attach_to` / `examples` — free text an admin fills in from a "Classify
Activity" section on Admin → Activity Types — and renders one card per activity
type that has any of the three set (a type with all three blank is silently
skipped, not shown empty). *(v1.377+: every active type except Meeting now gets a card, with
its icon in its icon color; a type with no Guide text shows a short "no details yet" line.)* Below the per-type cards, a team-wide **Distinctions**
section renders `teams.guide_distinctions` (e.g. "Discovery vs Demo"), edited from
the top of Admin → Activity Types since it isn't per-type. Both the page and the
admin Preview toggle render full Markdown, including single soft line breaks (a
line typed without a blank neighbor still gets its own visual break, not silently
merged into the paragraph per strict CommonMark rules) — this took several passes
to get right because a plain (unlayered) CSS rule was silently overriding the
Tailwind utilities meant to add paragraph/list spacing; watch for the same
layering trap in any future Markdown-rendering surface. An admin **Seed Default
Content** button (next to Add Activity Type) backfills blank Guide fields and
Subtypes for the currently-selected team directly, for the case where a seed
migration's hardcoded team-name match found no matching team and silently
skipped seeding.

### Subtypes *(v1.255–v1.256+)*

`team_activity_type_subtypes` — free-text labels an admin attaches to an activity
type (e.g. Discovery → Technical Discovery / Architecture Discovery), seeded for
the Sales Engineering team's 9 non-Meeting types. Shipped display-only in v1.255;
v1.256 made them selectable. `teams.subtypes_enabled` (default `false`) is a
team-wide kill switch gating the Subtype picker on the Log Activity form and
Activity Templates — a team that hasn't configured any Subtypes shouldn't
suddenly grow an extra dropdown just because the feature shipped. Selection is
stored as `activities.subtype_id` (`onDelete: 'set null'`) plus a denormalized
`subtype_name` snapshot — same convention as `sf_what_name` — so an admin later
renaming or deleting a Subtype never blanks out what a contributor actually
picked. `activity_templates` mirrors both columns. **Subtypes are ImpactIQ-only
and are never part of the Salesforce write-back payload** (`buildSfRecord()` in
`writeback.ts` does not read them) — do not wire them into SF field mappings.

**Dashboard rollout (v1.266–v1.270)** — Subtype awareness spread from the Log
Activity form out across the reporting surfaces: a Subtype filter chip (only
rendered for teams with `subtypes_enabled`) on Activity Type Breakdown and
Activity Mix (v1.266), a per-type expand chevron showing the Subtype split
on Activity Type Breakdown and Team Activity Deep-Dive (v1.266–v1.267), a new
standalone **Activity SubType Breakdown** dashboard using Subtype as the
primary row instead of Activity Type (v1.267, listed only Subtypes that
actually have logged hours as of v1.269), and a colored icon per group header
on the Subtype filter dropdown itself plus a color/icon legend on the new
dashboard (v1.270). Activity Mix's bar colors are tied to the parent Activity
Type (not whichever Subtypes happen to be present in the current filter) so
they don't shift under a Subtype filter — a real bug fixed in v1.267.

### Private Meetings *(v1.262–v1.262.1+)*

An Outlook event with `sensitivity` set to Private or Confidential — a
standard Graph calendar field, already inside the existing `Calendars.Read`/
`Calendars.ReadWrite` `$select` (no new Graph permission needed) — renders as
**"Private meeting"** with a lock icon everywhere in ImpactIQ (suggested-card,
calendar block, Edit drawer, event details modal) instead of its real
subject. This is a *display* substitution, not a Non-Activity mark: the
meeting still needs a decision, it just doesn't leak its subject while
waiting for one.

- `users.private_meetings_to_non_activity` (My Settings → Data & Templates,
  **on by default**) auto-excludes private meetings from the day list
  entirely, independent of any keyword rule — most teams don't want a
  private 1:1 cluttering the log queue at all.
- Card background uses the team's Non-Activity color (falling back to plain
  light gray), with a large transparent lock watermark (enlarged in v1.262.1
  after the first pass was too subtle to notice).
- The tentative-RSVP diagonal stripe (§10) and the private-meeting treatment
  compose independently — a card can be both private AND tentative.

### "Why Meeting?" capture *(v1.257+)*

Choosing the **Meeting** activity type on the Log Activity form shows an
optional free-text "Why Meeting?" field. Purely diagnostic — the goal is
learning whether a recurring reason ("status sync with X team") points at a
gap in the team's Activity Type list rather than everything genuinely
defaulting to the generic Meeting bucket. Reviewed on **Admin → Monitoring →
Activity Health** (v1.258): App Admins triage each captured reason as
Ignore / Will Watch / Addressed, with who reviewed it and when.

### Marketing "Event Name" capture *(v1.334+)*

Same name-matched pattern as "Why Meeting?" above, for the **Marketing**
activity type: an optional free-text "Event Name" field (`activities.
marketing_event_name`) with an example placeholder ("e.g. Innovate Security
Summit, Black Hat"). Purely a contributor-facing label for which event a
Marketing activity relates to — no admin triage workflow like meetingType
Reason's Activity Health page, since this isn't product research. ImpactIQ-only
— `buildSfRecord()` in `writeback.ts` never reads it, same "never part of the
SF payload" contract as Subtypes (§7) and meetingTypeReason.

### Support Tickets, Disconnected links, Opportunity Relink — see `docs/features.md`

- **Support Ticket attachment** *(v1.337+)*: a `ticket_picker` SF Extra on any Activity Type; tickets stored in
  `activity_sf_tickets` as an attach-time snapshot (refreshed in the background when the drawer opens), display fields
  resolved through CRM Field Mappings, never part of the write-back payload.
- **Activities Disconnected from SF** *(v1.344+)*: `sf_what_deleted` / `sf_who_deleted` / `sf_related_deleted`, set by
  the nightly `detect_disconnected_links` job and a drawer live-check, both via `checkSfRecordsExist()`, which lets a
  query error propagate so a failed check is never read as "deleted".
- **Opportunity Relink** *(v1.345+)*: `POST /api/activities/relink-opportunity` moves every activity (draft and
  submitted, all time) off a dead Opportunity, re-reads the target live on the admin connection, and re-queues synced
  rows through the normal write-back worker. Backed by the Closed Lost: Needs Review dashboard (§13).



---

## 8. SE Weekly View Layout

The primary contributor screen layout:

```
┌─────────────────────────────────┬──────────────────────────┐
│                                 │                          │
│   ACTIVITY LIST (this week)     │   OUTLOOK CALENDAR       │
│                                 │   (week view)            │
│   [+ Log Activity]              │                          │
│                                 │   [Collapsible panel]    │
│   Mon — 3 activities            │   ← expand/collapse →   │
│   ├── Demo - Acme Corp    ✓     │                          │
│   ├── Discovery - BetaCo  ✓     │   Click event to        │
│   └── Meeting - Internal  draft │   pre-fill form          │
│                                 │                          │
│   Tue — 1 activity              │   Already-logged events  │
│   └── Eval Work - GammaCo ✓     │   shown with ✓ badge     │
│                                 │                          │
└─────────────────────────────────┴──────────────────────────┘
```

- Left panel: activity list grouped by day for the current week
- Right panel: Outlook calendar (week view), collapsible
- AI suggestion badge shown on each activity card indicating suggested vs confirmed type
- Nudge notifications appear as non-blocking banners above the activity list
- **Phone layout** *(v1.419+)*: below 768px (`useIsMobile()`, `hooks/useIsMobile.ts`) the sidebar becomes a slide-in
  drawer opened from a menu button in `PageHeader` (`store/mobileNav.ts`), and the weekly view shows one pane at a time
  with a List / Calendar toggle in the week bar. The calendar and the panels under it are one `calendarPanel` /
  `calendarExtras` pair shared by both layouts. Desktop classes are unchanged (`md:` restores them)

---

## 9. Salesforce Integration

### CRM provider layer *(v1.383+)* — full write-up in `docs/crm-providers.md`

One install talks to one CRM (`system_settings.crm_provider`: `salesforce` | `hubspot` | `none`), never two. Read
`docs/crm-providers.md` before working in `services/crm/`, `services/hubspot/` or `services/criteriaiq/`. The rules that
matter everywhere:
- **Go through the provider.** Routes and jobs call `getActiveCrmProvider()` / `queueCrmActivitySync()`
  (`services/crm/index.ts`), never Salesforce code directly. `/api/salesforce/*` is guarded by
  `requireCrmProvider('salesforce')`; HubSpot is served by the CRM-neutral `/api/crm/*` routes. Every Salesforce or
  HubSpot scheduled job stands down quietly (no `job_runs` row) when its CRM isn't active. *(v1.437+)* List a new CRM
  job in `JOB_CRM` (`services/jobs/jobCrm.ts`): the scheduler, Run Now and Admin → Scheduling all read it, and the
  Salesforce and HubSpot sides keep matching jobs. *(v1.438+)* Any job that needs an integration also goes in `JOB_NEEDS`
  (`services/jobs/jobReadiness.ts`), so it waits, shown as Not set up, until that integration is connected. *(v1.439+)*
  Every job also gets a category in `JOB_CATEGORY` (`src/shared/jobCategories.ts`) for the Scheduling page groups.
- **The CRM is locked once CRM-linked data exists** (`crmProviderChangeAllowed()`, `src/shared/crmProvider.ts`), since
  record ids don't carry across CRMs. Any CRM can be chosen before its connection is saved; the card warns instead.
- **Activity CRM columns are `crm_*`** *(v1.411+)* and shared by both CRMs (HubSpot ids live in `crm_what_id`,
  `crm_record_id`, etc.); older text saying `sf_what_id` means the `crm_` name. *(v1.412+)* Tables holding data for any
  CRM are `crm_*` too (`crm_field_mappings`, `crm_users`, `crm_historical_*`, ...; §7 has the list). *(v1.413+)* So are
  the remaining CRM columns and the enum types (`crm_object`, `crm_user_id`, `crm_what_type`, ...); only Salesforce-only
  tables keep `sf_*`. HubSpot mappings live in `crm_field_mappings` with a HubSpot object name in `crm_object`.
- **Meetings HubSpot already logged** *(v1.410+)* are found and adopted on write-back instead of created twice; an
  adopted meeting (`activities.crm_record_adopted`) only ever gets ImpactIQ's own fields and is never deleted.
- **HubSpot**: one portal-wide service key / private app token (encrypted, no OAuth); users match HubSpot owners by
  email unless a manual link is set in User Management. Optional features (Leads, Campaigns, Projects, Tickets) follow
  the last access check. All calls go through `services/hubspot/client.ts` (fixed host, rate limiter).
- **Only an id the CRM confirms is gone gets flagged deleted**; a failed fetch never flips a flag. A HubSpot merge moves
  activities to the surviving record.
- **Projects (POC|POV) source** (`system_settings.evaluation_source`): CRM object, CriteriaIQ, or Off, locked once
  activities link Projects; CriteriaIQ can also be a secondary panel beside the CRM object.
- **Wording**: strings use `{{crm}}` / `{{crmShort}}` (§15); `_hubspot` context variants only where terms differ.
- **Historical import is meetings only on HubSpot** (decided v1.415): no calls, emails or tasks. Before a production
  HubSpot go-live, run `docs/hubspot-production-smoke.md`.

### Field Mapping (Admin-Configurable, Team-Scoped)
Field mappings are stored in the DB per team, not hardcoded. Admin can update SF field
API names without a code deploy.

```typescript
sf_field_mappings {
  id              uuid PRIMARY KEY
  team_id         uuid REFERENCES teams(id)
  app_field       text NOT NULL      // e.g., 'activity_type', 'title', 'effort_hours'
  sf_field_api    text NOT NULL      // e.g., 'Type', 'Subject', 'DurationInMinutes'
  sf_object       enum('Event', 'Task')
  is_active       boolean DEFAULT true
  updated_by      uuid REFERENCES users(id)
  updated_at      timestamptz
}
```

### Default Field Mapping Seed (Sales Engineering team, Event object)
| App Field | SF Event Field | Notes |
|---|---|---|
| `title` | `Subject` | |
| `activity_type` | `Type` | From team's allowed picklist values |
| `start_datetime` | `ActivityDateTime` | |
| `effort_hours` | `DurationInMinutes` | Convert hours × 60 on write |
| `sf_what_id` | `WhatId` | Set by user's search selection |
| `notes` | `Description` | |
| `user_id` → SF user | `OwnerId` | Resolved via Okta email → SF User lookup |

### WhatId Resolution
- User searches via **Opportunity** tab → `WhatId = OpportunityId`, `sf_what_type = 'Opportunity'`
- User searches via **Account** tab → `WhatId = AccountId`, `sf_what_type = 'Account'`
- The search tab context determines WhatId — never infer it

### Salesforce Lookup — Contributor Filtering
*(v1.474+)* The default Opportunity search matches `OwnerId` OR any Opportunity field the team maps to the
`opp_se_filter` app field (CRM Field Mappings, several rows allowed; `shared/salesforceSeFilter.ts`,
`services/salesforce/seFilter.ts`). Lookup/Id/text fields compare the user's Salesforce User Id; picklists and
multi-selects also match the user's name. Fields the org lacks are dropped via a cached describe. Never hardcode a
custom field here: with nothing mapped, the search is owner-only. The Assigned SE picker uses only `assigned_se_write`
(hidden when unmapped). Migration 0186 mapped the four previously hardcoded fields for installs already on Salesforce.
HubSpot's equivalent is `deal_se_owner`. Always provide an "Open Search" toggle that bypasses the filter.

### SF Object Type Per Activity
Each activity type can write to either an SF Event or SF Task — configured per type in
`team_activity_types.sf_object_type`. Write-back logic must read this field and use the
correct SF object. Default for all types is Event.

### Write-back
- Asynchronous — never blocks the contributor workflow
- Job queued on activity submit, processed in background
- SF sync status (`pending` → `synced` / `failed`) visible to contributor
- Failed sync surfaces retry option to contributor
- **ACV secondary write-back to Opportunity respects the mapping's direction** *(fixed v1.296)*
  — after the Event/Task write, `writeback.ts` optionally pushes `activities.acv` onto the
  linked Opportunity via the team's `acv` mapping. This used to fall back to a hardcoded
  `Total_Acv__c` whenever `resolveSfField()` found no active write-capable mapping — meaning
  setting the `acv` mapping to read-only in Admin → SF Field Mappings had **no actual effect**;
  the write happened regardless. There's no seeded default for this mapping, so the admin's
  configured direction is the only signal of intent — absence of a write mapping now means the
  write is skipped entirely, not silently redirected to a hardcoded field name.

### Field mapping validation, record preview and other Salesforce detail — see `docs/salesforce-details.md`

Covers: Validate & dry run (`POST .../sf-field-mappings/validate`, always 200, reuses `buildSfRecord()` so the preview
can't drift), Sample record, the hover record preview (`GET /api/salesforce/preview/:type/:id`, user's own connection,
local snapshot as the floor), Assigned SE read/write (`assigned_se_write` app field), the Evaluation (Project)
relationship, the Total Bookings breakdown, Historical Activity Import (`sf_historical_*` tables, never mixed into
`activities`, estimated hours excluded from cost/capacity math), the Engineer Notes prepend-update, and pushing notes
to Salesforce from the activity drawer. Read the relevant part before changing any of them.



---

## 10. Outlook Calendar Integration

### Layout
- Calendar rendered in right panel of the contributor weekly view
- Panel is collapsible (user can hide it for more activity list space)
- Default: expanded

### Behavior
- Week view default; day view available
- Click any calendar event → pre-populate activity log form (slide-in or modal)
- Events already linked to a logged activity display a visual "logged" badge
- If SE clicks an already-logged event → show warning, prevent duplicate
- Manual activity creation always available (not tied to a calendar event)
- Calendar respects contributor's timezone

### Graph API Scopes
```
Calendars.Read
User.Read
```

### User timezone source *(v1.469+)*
`users.timezone_source` (`auto` | `crm` | `manual`, `src/shared/timezoneSource.ts`): only `auto` lets the Outlook mailbox
check or the Salesforce connect seed change `users.timezone`; a CRM or manual pick sticks. Connecting Outlook resets it to
`auto`. `users.outlook_timezone` keeps the mailbox zone for Settings. Any new code that writes `users.timezone` must
respect the source. *(v1.471.1+)* Graph sends Windows names ("Pacific Standard Time"), which Intl rejects: pass any
timezone from Outlook through `normalizeTimeZone()` (`src/shared/windowsTimezones.ts`) before storing or using it.

### The ImpactIQ Outlook category *(v1.244+)*

An approved activity marks its Outlook meeting with the `ImpactIQ` category, so
a logged meeting is identifiable from Outlook itself. Two distinct code paths,
and they were not equivalent until v1.244:

- **ImpactIQ-created events** (write-back, activity had no `outlook_event_id`) —
  the category ships in the create payload (`graphEventBody` in
  `services/outlook/client.ts`).
- **Existing meeting invites** (activity created FROM a calendar event) —
  write-back is deliberately skipped for these, since creating an event would
  duplicate the meeting. That meant the category was *never* applied to a
  meeting someone else organized. `ensureEventCategorized()` closes the gap:
  reads the event's current `categories`, appends `ImpactIQ` if absent, PATCHes.

Rules for this path:
- **Merge, never overwrite.** `categories` is one mailbox-local list; a blind
  PATCH wipes the user's own colour-coding.
- Safe on meetings organized by others — in Graph, `categories` is per-mailbox,
  so patching touches only the caller's copy and notifies nobody.
- Gated on `users.outlook_writeback_enabled` (the flag that means "ImpactIQ may
  write to my calendar", and what caused `Calendars.ReadWrite` to be granted).
- Fire-and-forget and idempotent. Approval must never get slower or fail because
  of a calendar cosmetic; `POST /api/activities/:id/resync` retries it.

### Title write-back for an existing meeting invite *(v1.336+)*

The title/subject counterpart to the category sync above, added once live testing
against a real tenant confirmed the same mailbox-local-write shape applies: a
non-organizer attendee editing a meeting's subject directly in Outlook saves —
but only on that attendee's own calendar, never propagating to the organizer or
other attendees. `ensureEventTitleSynced()` (`services/outlook/client.ts`) PATCHes
`subject` under that identical safety contract — GETs the current subject first
and skips the write when it already matches (every submitted-activity write hits
this, not just an actual title edit, so the no-op check avoids a Graph call on
every save), otherwise PATCHes. Fires from the same three call sites as
`ensureEventCategorized()` (now `maybeSyncOutlookEvent()` in `routes/activities.ts`,
covering both) — same `outlook_writeback_enabled` gate, same submitted-only /
existing-meeting-only scope, same fire-and-forget contract. Skipped when
`isPrivateMeeting` is true — `activities.title` already holds the real subject
even though the UI substitutes "Private meeting" for display (§7), so a
contributor-edited Title on a flagged-private meeting is never pushed to Outlook.

### Deleted approved activities *(v1.242+)*

When an APPROVED activity's Outlook meeting is deleted from the calendar, the
activity is flagged for review rather than left pointing at nothing.

- `activities.outlook_deleted_at` / `outlook_deleted_kept`. Set **only** by the
  deletion-reconcile pass in `syncUserCalendar`, which sits after that
  function's `events === null` early-return — so it can only fire off a
  **successful** Graph fetch. "Absent from Graph" and "deleted" are not the same
  thing; flagging real logged work because a fetch failed is far worse than
  detecting it a sync later. Do not move this check anywhere that can run on a
  failed or partial fetch.
- Covers both `outlook_event_id` and `outlook_writeback_event_id`. Activities
  with neither were never on the calendar and are never flagged.
- Reappearance clears **both** columns, so a re-created meeting starts fresh and
  a stale Keep can't suppress a future real deletion.
- Surfaced as a "This Week's Deleted Activities (Approved)" section above the
  first day of the week, exempt from every list filter (an exception queue a
  filter can hide is one that silently loses items), plus an all-weeks count on
  the notification bell and the header banner (riding `/api/notifications` meta
  alongside `syncFailedCount`).
- **Keep** → `outlook_deleted_kept = true`, keeps the row in ImpactIQ + SF,
  stops re-flagging, renders a "Not In Outlook" badge and a grey RIGHT border on
  the calendar block (left edge is the activity-type colour bar).
- **Delete** → the only HARD delete in the product: row removed from Postgres
  (children first) and the SF Event/Task destroyed. An SF failure does not block
  the local delete — the row would otherwise be stranded in a queue whose
  purpose is emptying — and is reported back plus recorded in the audit meta.
  The `activity.outlook_deleted.purge` audit row carries the full identifying
  payload because after a hard delete it is the only surviving record.
- **Pending-decision indicators on the personal calendar surfaces** *(v1.363+)* —
  a still-pending flagged activity (non-null `outlook_deleted_at`, `outlook_deleted_kept
  = false`) shows up on both calendar views a contributor already uses to navigate their
  own weeks, so the queue is visible without opening the exception section first: a small
  red dot, top-right corner, on `MonthHeatmap.tsx`'s month-grid cells (`GET /api/activities/
  month-heatmap` now also returns `outlookDeletedStarts`, a second start-date array parallel
  to `starts`), and the day number itself turns red (or gets a red ring, for today's blue-
  filled circle) in `CalendarPanel.tsx`'s week header. Both read a per-day boolean computed
  from the activity list already loaded for that view — the main `GET /api/activities` list
  select gained `outlookDeletedAt` alongside the pre-existing `outlookDeletedKept` for this —
  no new endpoint for the week view. Both surfaces carry a hover tooltip explaining what the
  indicator means. Leader-dashboard-facing surfaces are untouched; this is personal-queue-only,
  matching the rest of §10's contributor-scoped review flow.

### Event Pre-population Mapping
| Graph API Field | Activity Form Field |
|---|---|
| `subject` | `title` |
| `start.dateTime` | `start_datetime` |
| `end.dateTime` | `end_datetime` |
| Duration (calculated) | `effort_hours` (pre-filled, editable) |
| `id` | `outlook_event_id` (hidden, stored for dedup only) |

---

## 11. Hybrid Intelligence Engine

### Team-Scoped
All keyword rules and nudge rules are scoped to a team. Each team has its own ruleset
and its own AI classification context (the activity types available to that team).

**Team assignment lives in the `keyword_rule_teams` / `nudge_rule_teams` junction
tables, not the `team_id` column on the rule row itself** *(fixed v1.297)* — that
column is only the "home" team set at creation. Every admin route that lists,
creates, or updates a rule (`admin.ts`'s keyword-rules/nudge-rules CRUD) already
reads/writes team assignment through the junction table, including the "Assign to
teams" multi-select. Both runtime engines — `matchKeywords()` in
`services/ai/classify.ts` and `evaluateNudges()` in `services/nudge/engine.ts` — now
resolve applicable rules the same way (`INNER JOIN` on the junction, filtered by
`is_active`). Before this fix they filtered on the stale `team_id` column directly:
a rule reassigned to a different or additional team after creation would still show
up correctly in the admin editor (which goes through the junction) but would
silently never match or fire for real users on that team — indistinguishable from a
broken trigger from the admin's side. This was the actual root cause of a
`no_activity_days` Nudge Rule Preview showing "0 of N members match" against
provably overdue members. The "duplicate team" flow (`admin.ts`, team clone route)
had the same bug in both directions — it read source rules by the stale `team_id`
column (silently skipping any rule only junction-assigned to the source team) and
never inserted a junction row for the copies (leaving cloned rules invisible in the
new team's own admin list) — both fixed the same pass.

### Layer 1: Rules-Based Keyword Matching (Primary)
```typescript
keyword_rules {
  id              uuid PRIMARY KEY
  team_id         uuid REFERENCES teams(id)
  keywords        text[]
  activity_type_id uuid REFERENCES team_activity_types(id)  -- NULL when action='mark_non_activity'
  match_field     enum('subject', 'body', 'both')
  priority        int
  is_active       boolean DEFAULT true
  action          enum('suggest_type', 'mark_non_activity') DEFAULT 'suggest_type'
}
```
- Highest-priority matching rule wins
- HIGH confidence (exact keyword match) → auto-suggest with confidence badge
- LOW confidence / no match → pass to Layer 1.5

**`action` *(v1.240+)*** — `suggest_type` is the original behavior and requires
`activity_type_id`. `mark_non_activity` requires it to be NULL: the rule doesn't
suggest a type at all, it upserts `non_activity_events` for that (user, event),
exactly as the manual Non-Activity button does. Surfaced in the admin UI as the
last entry in the *same* Activity Type dropdown ("Non-Activity"), not a separate
Action field — it reads as one more thing a match can resolve to. The required/
forced-NULL invariant is enforced in the admin route, not a DB constraint.

**Shared rules and team types** *(v1.467.1+)*: a rule stores one team's `activity_type_id`, so on any other team it
resolves to that team's type of the same name (`services/keywordRules/scope.ts`). A save refuses a team with no such
type, and replaces on every other team in the scope a rule it fully covers (keywords a subset, same type and action).

### Layer 1.5: The contributor's own Non-Activity keywords *(v1.243+)*
`users.non_activity_keywords` (text[]), edited in My Settings → Data & Templates.
Subject-substring, case-insensitive, applies to that user's ImpactIQ only.

Ordering is deliberate: **after** the team rules (an admin rule that assigns a
real activity type still wins) but **before** the AI classifier (an explicit
instruction from the user should outrank a guess). Subject only — the team rules
offer a `match_field` choice because a ruleset is maintained by someone thinking
about precision; this is one comma-separated field a contributor fills in once,
and body matching would silently catch meetings whose subject looks nothing like
the keyword.

Reports `source: 'user_keyword'` (not `'keyword'`) so the card can say "Your
keyword" and link to My Settings — sending someone to Admin → Keyword Rules to
find a rule that isn't there, on a page they may not have access to, is worse
than not explaining it at all.

### Layer 2: AI Classification (Fallback)
- Runs through the AI Assistant gateway (`runAi()`, §14) on whichever provider the admin routed `activity_classify` to, else the default
- Answers are cached per event in `ai_classification_cache` (v1.392+), "nothing fits" included
- *(v1.473+)* A calendar sync sends all of a person's unmatched meetings in one request (`classifyManyWithAI()`, 40 per
  request at most); `ai_requests.item_count` records how many items a request covered (Usage → Requests, Items column)
- Prompt includes team name and team's active activity type list as context
- Returns suggested type + confidence score
- Always a suggestion — contributor must confirm
- Never auto-selects without contributor confirmation

### Fallback when nothing matches *(v1.240+)*
`team_activity_types.is_default_suggestion` — at most one per team, set from
Admin → Activity Types (a "Default" star pill on the row).

Before v1.240 this fell back to `types[0]` off an **unordered** query, which is
why every unmatched meeting read as "Demo": Postgres happened to return the
first-seeded row first. Nothing chose it. v1.240 replaced that with the
lowest `sort_order`, which was still a guess nobody configured; v1.241 removed
the guess entirely.

Current behavior: use the configured default if one is set, otherwise leave the
event **untyped** and render "No Match" (§7). Do not reintroduce a positional
fallback — a confident wrong type is worse than an honest blank.

### Layer 3: Rules-Based Nudge Engine (Team-Scoped)
```typescript
nudge_rules {
  id              uuid PRIMARY KEY
  team_id         uuid REFERENCES teams(id)
  name            text NOT NULL   -- admin-editable display name (v1.324.0, see below)
  trigger_type    enum('no_activity_days', 'stage_no_type', 'type_no_followup')
  trigger_config  jsonb    // e.g., { days: 5 } or { stage: 'Eval', type: 'Eval Work', days: 14 }
  message_template text    // supports {opp_name}, {account_name}, {days} tokens
  is_active       boolean DEFAULT true
}
```

**`name`** *(v1.324.0)* — an admin-editable display name distinguishing rules that share the
same `trigger_type` (a team can have several `no_activity_days` rules with different configs).
Backfilled (migration 0143) to a Title Case version of `trigger_type` (underscores → spaces) for
every pre-existing rule; freely renamable afterward from the Nudge Rules admin screen. This is
what Nudge History's "Nudge" filter/column and the KPI cards below identify a rule by — not the
raw `trigger_type`, which was never unique enough for that once multiple rules share one trigger.
A `nudge_events` row whose originating rule was later deleted (`nudge_rule_id` set null,
`onDelete: 'set null'`) falls back to the same Title Case formatting of its own stored
`trigger_type`, so an orphaned history row still reads as a name rather than a blank.

Default nudge rules seeded for Sales Engineering team:
| Trigger | Message |
|---|---|
| No activity logged in 5 business days | "Nothing logged this week yet — catch up before Friday?" |
| Opportunity in active stage, no Eval Work in 14 days | "No Eval Work logged for {opp_name} in {days_overdue} days — anything to capture?" |
| Discovery logged, no Demo in 21 days | "You logged a Discovery for {account_name} {days_overdue} days ago — did a Demo follow?" |

**Rich tokens** — `{user_name}`, `{team_name}`, and *(v1.287+)* `{days_since_activity}`
(days since the user's most recent logged activity, `'—'` if never) are computed once per
evaluation in `evaluateNudges()` and substituted in a final pass, so they work on **any** rule
regardless of trigger type — unlike `{opp_name}`/`{days}`/etc., which are trigger-specific and
substituted inline where that trigger emits.

**`{days_overdue}`** *(v1.294+)* — trigger-specific (substituted inline, like `{opp_name}`), on
`stage_no_type`, `type_no_followup`, and `opportunity_stale`. `{days}` in a template is always
the admin's configured threshold ("no Eval Work in 14 days" reads 14 no matter what); `{days_overdue}`
is the real, uncapped gap for the specific record the nudge is about — the last time the relevant
activity type was actually logged against it (or, if never, since it first showed up / since the
`fromType` activity that started the clock), which is frequently larger than the threshold once
someone stops looking at a deal. The seeded `stage_no_type`/`type_no_followup` default templates
use `{days_overdue}` rather than `{days}` for exactly this reason — an existing team's
already-customized message text is data, not code, so this only affects newly-seeded teams; an
existing rule needs an admin to add the token to its Message Template manually to pick it up.

**Admin can now edit Trigger Type + Trigger Config on an existing rule** *(v1.284+)* — this was
previously only settable at creation (`POST /nudge-rules`); the same PATCH route always
accepted both fields, the admin UI just never exposed an editor for them. Changing Trigger
Type resets Trigger Config to that type's default shape in the same request, so an old
`{stage, type, days}` config never lingers meaninglessly under a switched-to `no_activity_days`
rule.

**Three dismiss actions, one deliberately exclusive to one surface** *(v1.287, reworked
v1.292)* — every nudge surface (notification bell, weekly-view card, bottom toast) offers
**Mark read** (checkmark) and **Snooze** (bell icon, 1/7/30-day picker), which behave
identically everywhere: Mark read inserts a `nudge_dismissals` row with `expires_at` = next
UTC midnight (`muteNudgeRuleUntilNextUtcMidnight()`, `services/nudge/dismissals.ts`); Snooze
inserts one with `expires_at` = now + N days (`POST /api/nudges/dismiss`). **Close out**
(`expires_at = NULL`, meaning "never re-fire this rule for this user" —
`evaluateNudges()`'s dismissal filter treats `NULL` and "expires in the future" as equally
active) is available **ONLY** from the notification bell's X (`DELETE
/api/notifications/:id` → `closeOutNudgeRuleForever()`), by deliberate product decision — the
weekly-view card and the toast only ever show Mark read + Snooze, never a permanent option,
so a reminder can't be silenced forever from a quick-glance surface. `POST /api/nudges/dismiss`
no longer accepts a `permanent` flag (removed v1.292 once the weekly-view card's close-out
button was removed — the bell is the only remaining permanent-dismiss code path). The weekly-
view card and toast reach "mark read" via a dedicated `POST /api/nudges/mark-read { ruleId }`
route, since neither has a `notifications` table row to key off the way the bell's `PATCH
/api/notifications/:id/read` does. There's still no admin surface listing who has closed out
or snoozed which rules (a pre-existing gap, not addressed by this rework).

**Two real gaps found and fixed post-v1.292** *(v1.294)*: (1) The bell's Snooze had been calling
`DELETE /api/notifications/:id` as a row-cleanup step *before* v1.292 repurposed that same route
to mean permanent close-out — so every Snooze click was silently ALSO closing the rule out
forever underneath whatever N-day duration the user picked (a permanent dismissal always wins
in `evaluateNudges()`'s filter, so the N-day choice was never visible). Fixed by moving the
notifications-row cleanup server-side into the action itself (see below) so the client no
longer needs a second call. (2) Mark read / Snooze triggered from the weekly-view card or the
toast (both keyed by `ruleId`, with no `notifications` row id) only ever mutated the CLIENT's
optimistic cache — the underlying bell row was untouched server-side, so a poll or reload
resurrected it even though the mute was genuinely in effect. `muteNudgeRuleUntilNextUtcMidnight()`,
`snoozeNudgeRuleForDays()` (new — the `/dismiss` route's logic moved here from being inline), and
`closeOutNudgeRuleForever()` now all sync today's matching `notifications` row themselves
(mark read → `isRead = true`; snooze/close-out → delete the row) inside `services/nudge/dismissals.ts`,
so every action is correct from every surface regardless of which one triggered it, and survives
a refresh. Lesson: a client-side "keep two caches in sync" trick (`dropNudgeNotification`) is fine
for *instant* UI feedback, but the server-side row is the actual source of truth — mutate it, not
just the cache, or a poll silently undoes the fix.

**Slack routing** *(v1.433+)*: a team's Incoming Webhook (`teams.slack_webhook_url`) gets every nudge and every
team-wide announcement with Slack on; a person gets a bot DM (`deliverSlackDmToUser()`, `services/slack/dm.ts`) for a
rule with `send_slack_dm` and for a subteam/person announcement with `send_slack` (sent once, `slack_sent_at`). A DM
needs a linked `users.slack_user_id` and `user_notification_prefs.slack_dm_enabled`. Nudges are evaluated both by the
bell's poll and by the `notification_sweep` job (`services/nudge/sweep.ts`, working hours in the user's timezone); both
go through `syncNudgeNotifications()` (`services/nudge/sync.ts`), whose per-day dedupe stops double delivery. Any new
nudge delivery channel goes there, not in the route.
Communications rules in `SLACK_DM_EMAIL_RULES` (`src/shared/emailRuleSlack.ts`) can also DM the email's recipient
(`email_rules.send_slack`, v1.436+): pass `userId` to `sendByRule()` from any new caller of those rules.

**Nudge via Microsoft Teams — designed, not shipped.** Slack (team channel and bot DMs, above) and email are the only delivery channels
today. The recommended design for a Teams channel mirrors the Slack pattern 1:1 (new
`teams.teams_webhook_url`, a `deliverTeamsNudge()` alongside the existing Slack call in
`syncNudgeNotifications`) — the one open blocker is confirming which webhook payload format
this org's Teams tenant actually supports (classic `MessageCard` Incoming Webhooks vs. the
newer Workflows/Adaptive-Card format Microsoft has been pushing tenants toward), since building
against the wrong one silently fails. Do not start this without that confirmation.

---

## 12. Capacity Model

### Configuration Levels
Capacity targets are set at the group level, not directly per team. A `capacity_group` can span
multiple teams (`capacity_group_teams`), but a team can belong to at most one group at a time
(enforced by a unique constraint on `team_id`). A contributor's target is resolved from their
current team membership → the team's attached group → an optional per-user override, all in
`src/server/services/capacity/resolver.ts`.

```typescript
capacity_groups {
  id                       uuid PRIMARY KEY
  name                     text NOT NULL           // e.g., 'EMEA SEs', 'APAC FDEs', 'Americas SEs'
  target_hours_per_week    decimal(4,1)
  capacity_method          enum('fixed_hours', 'self_declared', 'exception_adjusted', 'calendar_derived')
  region                   text
  role_type                text                    // e.g., 'SE', 'FDE', 'Specialist'
  show_real_meeting_load   boolean DEFAULT false   // see §12.1 — independent of capacity_method
  created_at               timestamptz DEFAULT now()
}

capacity_group_teams {
  group_id      uuid REFERENCES capacity_groups(id)
  team_id       uuid REFERENCES teams(id) UNIQUE   // a team belongs to at most one group
  PRIMARY KEY (group_id, team_id)
}

capacity_user_overrides {
  id                     uuid PRIMARY KEY
  user_id                uuid REFERENCES users(id)
  team_id                uuid REFERENCES teams(id)
  target_hours_per_week  decimal(4,1) NOT NULL
  reason                 text NOT NULL   // pto | ramp | rotation | reduced | special_project | other
  effective_from         date NOT NULL
  effective_to           date
  created_by             uuid REFERENCES users(id)
  created_at             timestamptz DEFAULT now()
}
```

A user override whose date range covers "now" always wins over the group's method — it's the one
per-person, time-scoped exception every method respects equally.

### Capacity Methods
| Method | Description |
|---|---|
| `fixed_hours` | Static target hours/week (e.g., 30hrs) |
| `self_declared` | Contributor's own work-day hours, floored at the group target |
| `exception_adjusted` | Same computation as `self_declared` today — the documented distinction (flat hours minus flagged exceptions) has never been implemented |
| `calendar_derived` *(v1.225+)* | Target is the user's own trailing 8-week average real meeting load (§12.1), falling back to the group's `target_hours_per_week` when there isn't enough calendar history to trust an average |

### 12.1 Calendar-derived meeting load *(v1.225+)*

`outlook_events` now also stores `show_as`, `is_cancelled`, and `response_status` — Graph fields
the original `$select` never fetched, so every cached non-all-day event counted as busy time
before this, including declined meetings, cancelled meetings, and events marked Free.
`src/server/services/capacity/meetingLoad.ts` defines one predicate (`isRealMeetingLoad`) that both
the dashboards and the resolver use to tell real, accepted meeting time apart from that noise. It
excludes cancelled, declined, Free, and `workingElsewhere` events, and correctly counts events
where the current user is the organizer (`response_status` reports `organizer`/`none`, not "no
response yet").

Two things are built on this predicate, deliberately kept separate:

- **A corrected "Meeting Load" figure** — shown alongside the existing logged/target hours on
  leader dashboards (This-Week Capacity, Capacity Trend, Team Heatmap), gated by
  `capacity_groups.show_real_meeting_load`. Additive, ambient context only — it changes no target
  math by itself. Never labeled "Availability" or "Capacity Used" in the UI; always "Meeting Load",
  with a tooltip stating the caveat below.
- **The `calendar_derived` capacity method** — a group's *target itself* is auto-computed from its
  members' trailing real meeting load. Both this method and the Meeting Load figure use the same
  trailing window (8 weeks, matching `anomalies.ts`'s `BASELINE_WEEKS`) and the same minimum-history
  floor (4 weeks, matching `MIN_BASELINE_WEEKS`) before trusting an average, so "baseline" means one
  thing app-wide.

**Two caveats that must stay visible in the product, not just here:**
1. **This measures meeting load, not availability.** An empty calendar is not free time — it just
   means no meetings were scheduled. Both signals can be systematically wrong for anyone whose real
   work doesn't show up as calendar events.
2. **This is a trust-boundary shift, not just a new number.** Reading a calendar to pre-fill an
   activity (§10) is a contributor-initiated, single-event action. Reading a calendar to compute
   someone's capacity target is an ongoing, admin-configured read of someone else's calendar
   feeding a number a Team Leader sees — a different kind of read. That's why both signals are
   gated per-group by App/Team Admin (the same trust level that sets `fixed_hours` today), never a
   per-contributor opt-in, and why the admin UI states the caveat in its own help text rather than
   only here.

**Closed the client-side gap (v1.309)** — `isRealMeetingLoad()` moved to `src/shared/meetingLoad.ts`
so `WeeklyView.tsx`'s own `otherMeetingHours` calculation imports the exact same predicate the
server uses, instead of a hand-duplicated copy that only excluded `alreadyLogged`/`isAllDay`. The
client already had every field the predicate needs (`isCancelled`/`showAs`/`responseStatus` on
`useCalendar.ts`'s `CalendarEvent` type, populated by every non-demo `GET /api/outlook/calendar`
code path) — this was a pure display fix, no API/response-shape change. One known, accepted
limitation: demo-mode fixture events (`services/demo/generator.ts`) never set `showAs`/
`isCancelled`, so under the predicate's own null-handling they always count as real load — a safe
default, not a crash, and not fixed as part of this pass.

---

## 13. Leader Dashboards (Team-Scoped)

Read-only. All data from submitted activities only. Grouped by section (Capacity, Activity, Accounts, Health, Products, Revenue, Manager, Infrastructure, Coverage, History) in the dashboard selector.

### Capacity
- **Team Heatmap** — weeks × contributors matrix, hours color-coded vs capacity target, click to drill in
- **This-Week Capacity** — current week's utilization per user
- **Capacity Trend** — weekly capacity delta line chart

### Activity
- **Activity Breakdown** — per-contributor effort hours by activity type
- **Activity Mix** — team pie/bar of activity type split
- **Plan vs Actual** — planned vs logged hours
- **Activity SubType Breakdown** *(v1.267+)* — same Team Total / per-contributor layout as
  Activity Breakdown, but Subtype is the primary row instead of Activity Type; every bar keeps
  its parent type's color and icon. Only lists Subtypes that actually have logged hours
  (v1.269) — no empty "whole Activity Type" rows for types with none logged
- **Activities Disconnected from SF** *(v1.344+)* — flat table of every submitted activity
  whose linked Salesforce record (What/Who/Related) has been deleted, per the nightly
  `detect_disconnected_links` job (§7). Reads only local Postgres flags, so it's fast and works
  regardless of the viewing leader's own SF connection. One row per activity — a link to open it
  in the drawer (correctly landing on its own week via `startDate=`, not the `start=` param
  `SyncHistory.tsx`'s own deep link mistakenly uses), the owner, team, and a badge per broken
  link linking out to the last-known Salesforce record. Deliberately no date/cost/compare
  filters — a broken link is either broken right now or it isn't, independent of when the
  activity happened. Ships unconfigured/opt-in like most dashboards — grant
  `dashboard.sfDisconnected` via Role Management
- **Activities Disconnected from Outlook** *(v1.362+)* — the same flat-table pattern as
  Activities Disconnected from SF above, for the OTHER side of the "link went away" problem: an
  approved activity whose Outlook meeting was deleted (§10), still sitting in the owner's own
  Keep/Delete queue. Read-only — a leader/admin sees the queue and how long each row has been
  flagged (day/type/hours/owner/team), but the actual Keep/Delete decision stays with the owning
  contributor (§5: leaders cannot edit contributor activities); each row links out to the
  activity's own week via the same `?openActivityId=&startDate=` deep link used everywhere else
  in this file, rather than acting on the row directly. Reads `activities.outlookDeletedAt IS
  NOT NULL AND outlookDeletedKept = false`, submitted-only, same as the personal queue. Ships
  unconfigured/opt-in — grant `dashboard.outlookDisconnected` via Role Management

### Accounts
- **Account / Opportunity Burn** — ranked hours per Account/Opp, with roll-up toggle
- **Account / Opportunity Concentration** *(renamed + reworked v1.272)* — top-N share of total
  hours. Now measures real Accounts: activity on an Account's Opportunities and converted Leads
  rolls up into that Account instead of rendering as its own separate bar (previously inflated
  the effective count of "accounts" per contributor). Click a bar to see the
  Opportunities/Leads making it up
- **Most Expensive** *(v1.137+)* — top-25 objects by cost of effort, icon toggle across Accounts / Opps / Campaigns / Leads. Account view rolls up child Opps + converted-Lead cost via `sf_lead_account_link` cache

### Health
- **Logging Compliance** — % of expected activities submitted
- **Logging Lag** — time from event → activity submit
- **Week-over-Week Delta** — hours shift vs prior week
- **AI Assessment Scores** *(v1.463+)* — `GET /api/dashboards/ai-assessments` (`routes/dashboards/aiAssessments.ts`,
  aggregation in `services/aiAssessments/dashboard.ts`). Submitted activities only, never the caller's own, teams from
  `assessmentScoreTeamIds()` (same grant as the drawer's Assessments tab). Per assessment: both averages, by person, by
  criterion, scored activities. Grant `dashboard.aiAssessments` (leader + team_admin by default)

### Products
- **Products Breakdown** — per-product effort hours (uses team-scoped `products` config)

### Revenue
- **Opportunity ROI** — ACV / hours-invested scatter
- **Cost per ACV** — dollar-cost per $ ACV touched

### Manager
- **Team-of-Teams Rollup** *(v1.132+)* — cross-team KPI table with 6 colored stat cards (Total Hours, Cost, ACV, Activities, Most Expensive Account, Biggest Impact User). Requires access to multiple teams
- **Sales Team Breakdown** — SF Sales-team aggregate
- **User Leaderboard** *(v1.137+)* — per-user Total ACV, Closed ACV (won-only), Cost, Net Deal Margin, Efficiency Ratio (Closed ACV ÷ Cost)
- **Team Activity Deep-Dive** *(v1.245+)* — the one Manager-group dashboard that is deliberately single-team, not cross-team: a 3-tier collapsible tree (Activity Type → Subteam → Team Member, sorted by Total Count descending at every tier, fully collapsed by default) showing Total Count, AVG Duration (Hours), Total ACV Connected To, AVG Count Per Oppty, and AVG Per Week/Month/Quarter/Year. Every active Activity Type × every current team member is shown even at zero activity — Subteam/Team-member filters narrow the roster itself (non-matching branches disappear), while Products/Stage/Forecast/ACV narrow the metrics without removing roster rows. Total ACV and AVG Count Per Oppty exclude non-Opportunity-linked activities (MAX-per-Opportunity, same rule as every other ACV figure in the app); Total Count, AVG Duration, and the four period averages do not — a deliberate divergence from ProjectCosting/Most-Expensive's convention of dropping non-Opp rows entirely when a Stage/Forecast/ACV filter is active. AVG Per Week/Month are calendar-bucket counts; AVG Per Quarter/Year are fiscal-config-aware via `fiscalPeriodOf` — all four floored at a minimum of 1 (`src/server/services/dashboards/periodCounts.ts`). Requires a concrete team (renders a "select a specific team" empty state under All Teams)
- **Won w/o POC** *(v1.268+)* — Closed-Won Opportunities with ImpactIQ activity logged but no
  linked Evaluation (POC) record in Salesforce. Uses a **live** Salesforce read (needs the
  viewing leader's own SF connection), so it's the one dashboard that can go empty/degraded
  purely on SF connectivity rather than missing data. Needs a team with an Activity Type
  configured with a related-object picker for the Evaluation object. Rows grouped Subteam →
  User → Opportunity, with ACV and a count per Activity Type
- **Closed Lost — Needs Review** *(v1.345+)* — Opportunities closed Lost/Duplicate
  (`sf_is_closed = true AND sf_is_won = false` — a portable signal that doesn't assume any
  specific Stage label text, since Stage names aren't standardized org to org) that still
  have submitted ImpactIQ activity linked. A live, team-scoped query off already-fresh local
  snapshot columns — no new nightly job needed. One row per Opportunity: Account, Sales
  Stage, Close Date, Amount, Owner, ImpactIQ activity count, and last activity date.
  Clicking the Opportunity name opens the same `SfActivitiesModal` drill-in the rest of the
  app uses, which is also where the Relink action itself lives (§7 — one Relink UI, not two).
  **Dismiss** (`opp_review_dismissals`, permanent until Undismissed) suppresses a genuinely-
  fine case; a **Show Dismissed** toggle (off by default) reveals them. A relink naturally
  drops an Opportunity out of this query with zero extra bookkeeping — the same
  self-healing-by-construction principle as Activities Disconnected from SF. The candidate
  list itself still respects the dashboard's own date-range chips like every other
  dashboard — a normal, expected behavior distinct from the Relink action's own all-time
  scope (§7); don't conflate "which Opps show up in the queue today" with "how much moves
  when Relink is clicked on one." Gated `dashboard.closedLostReview` in Role Management.

### Infrastructure
- **Project-Specific Costing** — cost, hours, and ACV of Project (Evaluation)-linked activity,
  grouped by Project, Opportunity, Account, or Team/Subteam

### Coverage
- **Attach Rate** — what share of a rep's open Opportunity pipeline has an SE actively engaged
  on it, and who's covering the gaps. Two tables: **Rep Coverage** (pipeline breakdown by
  Team → Subteam → User, expand/collapse per row since v1.280) and **SE Credit** (which
  ImpactIQ users are getting attach-rate credit, and how). Both share `groupBreakdown()`'s
  flat, pre-ordered tree (`dashboards.ts`) so the two tables always agree on shape.
  - **Selecting a Team member/Subteam recomputes the whole rate** (v1.276), not just narrows
    the breakdown card — scoped via `sf_user_alignments` (which SF rep/owner Ids that person is
    aligned to cover), deliberately avoiding a circular "credited only by themselves" reading.
  - **Name vs. Id credit resolution** (v1.278–v1.280) — a credited SF value can be either a
    Salesforce User Id (`SF_ID_RX` match → resolve via `users.sf_user_id`) or a literal name
    string, when the org's Assigned SE / Supporting Engineers / etc. field is a picklist rather
    than a User lookup (same field-shape ambiguity as §9's Assigned SE). Both `/attach-rate` and
    `/attach-rate-breakdown` resolve name-valued credit against the team roster
    (`users.display_name`, case-insensitive) as a fallback when there's no Id to match — fixed
    a real false-positive where a fully-linked ImpactIQ user's name-valued credit was always
    treated as unmatched. A separate display-only `nameCache` map needs the SAME roster seeding
    as the resolver, or a name-resolved person's UUID leaks into the SE Credit table instead of
    their name — this specific gap recurred once (v1.280) after the resolver fix alone.
  - **"Not in ImpactIQ" red flag** — same treatment and same `isImpactIqUserName()`-style
    name-match convention as §9's SF preview popover, so a departed/external SF person credited
    on the pipeline visibly stands out from the team's own roster.

### Dashboard filter consistency *(audited + fixed v1.265–v1.274)*

A multi-pass audit found that several global filters (§13 "Global filters" below) were silently
ignored by dashboards that visually showed the filter chip but never actually read it
server-side — the chip looked live, the numbers weren't scoped. Fixed across this range:
Subteam/Team-member (most leader dashboards, v1.265), Sales Stage/Forecast (Account/Opportunity
Burn + Concentration, v1.272), and Products + Team-member/Subteam together on Opportunity ROI,
Cost per ACV, Most Expensive, and Attach Rate + its SE-Credit/Rep-Coverage breakdown (v1.274).
If you touch a dashboard's filter row, verify every chip shown is actually threaded into the
server query — this class of bug recurred multiple times across different dashboards before
the full audit closed it out.

### History *(v1.214+)*
- **Historical Activity (Pre-ImpactIQ)** — reads `sf_historical_events` only. KPI row, volume
  by year (counts primary, estimated hours as a toggle), top-accounts table, and account
  coverage over time, plus a linkage-quality pill showing what share of rows matched an
  ImpactIQ user. No cost, no utilization, and deliberately no per-owner leaderboard — these
  are estimates, and ranking people on an estimate invites a performance-review reading.
  Subteam / Team-member / Products chips are suppressed on this tab; date chips still apply.

### Anomaly callouts *(v1.220+)*

A collapsible **What changed** panel above the dashboard tab content, on every tab.
`GET /api/dashboards/anomalies`, `requireRole('leader','admin')`.

Answers the question the thirteen dashboards can't: "is anything off this week?" — without
making a leader sweep every tab to find out.

- **Fixed comparison window.** The last *completed* week against a fixed 8-week trailing
  baseline. Deliberately NOT the dashboard's date filter: "normal" is a property of the team,
  not of whatever range the leader happens to have selected, and switching to "All time"
  must not change what counts as unusual. Team scope and the Products filter still apply,
  since those define *whose* data. The panel states the window it used.
- **Detectors** — account / opportunity burn spike (vs that record's own mean over weeks it
  was actually touched, since SE engagement is lumpy), contributor over capacity (vs the
  resolved capacity target, so it runs with no history), contributor stopped logging,
  activity-type surge / collapse, unlinked-activity spike, and Salesforce write-back
  failures (visible in Admin → CRM Sync, but a leader never goes there).
- **Quiet by construction.** The failure mode of a panel like this isn't being wrong, it's
  being noisy — one that lights up every week is wallpaper within a month. So every detector
  carries a *volume floor* as well as a ratio threshold, and the output is hard-capped at 6
  with a "N more not shown" line. When history is thinner than 4 weeks the baseline-relative
  detectors switch off and the panel says so, rather than showing an empty box a new team
  would read as "all clear".
- Each detector is independently try/caught: one failing check yields no findings for that
  check, never a blank panel.

### Global filters (Manager / Revenue / Accounts groups only)
- **Sales Stage** + **Forecast Category** — multi-select chips, filter every dashboard in those groups. Values come from `activities.sales_stage` / `forecast_category` snapshot columns kept fresh by the nightly `refresh_opp_snapshots` job (v1.137+)
- **Refresh from Salesforce** button — manual trigger of the same refresher, always runs on the shared **admin** Salesforce connection regardless of which user clicks it (an org-wide snapshot write, not a per-user read — never per-clicking-user). Throttled to once per 30 minutes per user *(raised from 10min, v1.273)*, with a live countdown while throttled; `job_runs`' Recent Runs shows a Source column ("Refresh Button" vs "Scheduled") so a manual click is distinguishable from the job's own 24h cadence (v1.273). *(v1.271+)* Actually reports failure — previously the route always answered success even when the refresh couldn't run at all (e.g. no admin SF connection configured), so a failed refresh looked identical to a successful no-op. *(v1.275+)* The "no admin SF connection" error is role-aware: an App Admin sees "Go to Admin → Integrations to connect one," anyone else sees "Contact your App Admin"

---

## 14. Admin Configuration Screens

All team-scoped screens require an active team; global sections live under Global category.

**Configuration**
- Team Management — create/edit teams. *(v1.406+)* On HubSpot the Team Manager picker lists HubSpot owners and the department link lists HubSpot teams (§9)
- Activity Types — activate/deactivate types per team; SF object (Event/Task) per type; **Default suggestion** star pill (§11 — at most one per team; drives the "nothing matched" fallback). Salesforce Extras (per type) now has a third kind, **Ticket picker** (§7 v1.337+), alongside Opp field / Related picker. *(v1.405+)* Extras follow the active CRM: the Opp field kind reads HubSpot Deal properties on HubSpot, and an extra for the other CRM is shown dimmed and hidden from the activity form (§9). *(v1.374+)* **Export / Import** (next to Seed Default Content, team-admin gated like the rest of the page) — one versioned JSON file (`kind: 'impactiq.activity_types'`, `formatVersion: 1`) with every type the team sees, its icon/color/SF object/picklist override + `sf_event_type_config` row, Default star, Classify Activity text, Subtypes and SF Extras, plus the team's Guide Distinctions and Enable Subtypes toggle. Logic lives in `services/teams/activityTypesTransfer.ts`. Import is preview-then-apply like SF Field Mappings', and apply re-diffs inside ONE transaction. Types match by name (case-insensitive) and are never deleted; Subtypes are only added or re-ordered, never deleted (activities point at them by id); SF Extras for a matched type are replaced as a set when they differ (nothing references an Extra row); a name match on a shared type the team doesn't own is skipped. SF Field Mappings are NOT in this file — they have their own Export / Import. *(v1.464+)* The file also carries AI Assessments (`aiAssessments`, `services/aiAssessments/transfer.ts`): matched by name, shared/locked ones skipped, assignments only added. *(v1.465+)* Assessments have an icon and icon color (`ai_assessments.icon`/`icon_color`), carried in that file when present.
- SF Field Mappings — app field → SF API field per team. v1.138+ adds **Background refresh** and **Refresh only for reports** flags per mapping so the nightly `refresh_opp_snapshots` job pulls those fields from SF; migration 0087 seeds 11 refresh-only Opportunity mappings per team (StageName, ForecastCategoryName, Amount, IsClosed, IsWon, CloseDate, OwnerId, Owner.Name, Assigned_SE__r.Name, Primary_Engineer__r.Name, Evaluation__c). v1.219+ adds a **Validate & dry run** panel above the table — see §9. *(v1.285+)* App Field options include `eval_primary_engineer` (Evaluations__c Primary Engineer) — mapping a field that's a Salesforce Lookup auto-captures its target object in `reference_to` from `describe()`, which the Project preview then uses to auto-resolve a raw User Id to a name (§9) with no separate checkbox. *(v1.299+)* **Export / Import** — App Admin only, `GET .../sf-field-mappings/export`
  downloads every mapping currently assigned to the team as JSON (every checkbox, R/W direction,
  constant value, and team assignment — exported as portable `teamSlugs`, not raw UUIDs, so the
  file round-trips into a different install with different team ids; `updatedByEmail` captures
  who last configured each row). `POST .../import/preview` diffs the uploaded file against the
  team's CURRENT live mappings field-by-field and shows exactly what would change — this is the
  "call out any issues when there's been a change since it was exported" behavior: importing a
  stale file after a colleague edited the same mapping shows the real current value alongside
  what the file would overwrite it with, before anything is touched. `POST .../import/apply`
  re-diffs against current state (never trusts a diff computed at preview time) and applies
  create/update only — matched by `(appField, sfObject)`. Import never deletes: a team mapping
  absent from the file is left alone, and team assignment is only ever ADDED to, never removed,
  so importing can't silently un-assign a mapping from a team the file didn't happen to mention.
  Reuses the existing `sf_field_mapping.create`/`.update` audit actions (docs/history.md v1.289 E1) with a
  `source: 'import'` marker in `meta`, so imported changes show up in Audit Log identically to a
  manual edit.
- SF Picklist Config — Event/Task Type picklist values per team
- Keyword Rules — keyword → activity type per team, or **Non-Activity** as the last entry in the same Activity Type dropdown (§11). An info banner above the table states what happens to a meeting no rule matches, since that's the one thing a list of rules can't show
- Nudge Rules — create/edit/disable per team, with Slack + Email delivery toggles. *(v1.284+)* Trigger Type and Trigger Config JSON are now editable on an existing rule too (previously creation-only) — see §11. *(v1.324+)* Each rule has an editable **Name**, shown prominently on the rule row and editable inline in the expanded view (see §11) — Nudge Dismissals moved from a standalone page here into Nudge History (Monitoring & Audit, below) as a tab
- Capacity Groups — target hours per group per team
- Cost Groups — hourly cost rates per group per team (drives the dollar KPIs)
- Activity Templates — pre-filled activity forms per team
- **AI Assessments** *(v1.461+)* — scored rubrics (criteria, weight, 1–5 level anchors) a team defines, shares like Keyword Rules (`ai_assessment_teams`) and assigns per Activity Type / Subtype (`ai_assessment_assignments`, max 3 per row; a Subtype row wins over the type-wide row). Settings tab = the former Workplace → AI Notes. Scoring rules in `src/shared/aiAssessments.ts`: two scores (not-observed zeroed; observed-only + not-observed count), Leaders only, transcript required. *(v1.462+)* Scores in `activity_ai_assessment_scores` (rubric snapshot per row), written by AI Notes Generate when a transcript was read and by a Leader's Run assessment; shown on the drawer's Assessments tab only per `canSeeAssessmentScores()` (`services/aiAssessments/access.ts`: never the owner) *(v1.466+)* **Settings Profiles** (`ai_note_profiles`, Settings tab): built-in plus custom AI Note sections, picked per assessment (`ai_assessments.ai_note_profile_id`, same team only); `sectionPlanForActivity()` (`services/aiNotes/profiles.ts`) adds them to the owner's own sections wherever the assessment runs. Custom keys are `c_…`; items keep `section_meta` *(v1.471+)* The starred Default profile (`ai_note_profiles.is_default`, one per team) is the base for anyone without their own sections (`teams.ai_notes_default_sections` is no longer read); `combine_mode` `add`|`replace` decides whether an assessment's profile adds to or replaces that default (never a person's own sections), in `mergeProfileSections()`

**Users & access**
- User Management — role assignment, subteam membership, leader scope, capacity/cost group
  membership. *(v1.406+)* The linked CRM user follows the CRM: on HubSpot it links a HubSpot owner (overriding the email
  match) and shows the owner's HubSpot teams instead of Title/Manager (§9). *(v1.318+)* Per-user roster row shows a **Last Logged In** column (last successful
  `login_events` row, `Never` if none) alongside every existing field. Under the top team
  selector's **All Teams**, this page also renders a cross-team **group-by-Default-Team** view —
  previously "select a specific team" was the only thing shown there — with each team's section
  collapsible, a member count badge, and the same shared `<SubteamFilter>` chip (§19b, teams'
  own subteams) narrowing that section down to specific subteams. A user's role in the grouped
  view is read/written against their `team_members` row for THAT SPECIFIC team-group (not just
  "whatever role they hold anywhere"); a user whose `defaultTeamId` points at a team they hold no
  membership row on renders a "Not a member" badge instead of a role dropdown rather than
  guessing. Edit / Reset Password panels are shared verbatim with the flat single-team view
  (extracted into `renderEditPanel`/`renderResetPasswordPanel` so the two views can't drift);
  Add Member and the per-team "remove" trash icon are intentionally absent from the grouped view
  (ambiguous which team an action would target) — Create New User stays available since that
  form already carries its own team picker. *(v1.348+)* A **Connections** column (flat single-team
  view only) shows two small icons — Salesforce (`Cloud`) and Outlook (`CalendarDays`) — colored
  from `user_integrations`, joined into the same `GET /users` roster query that already computes
  Last Logged In (one extra indexed query for the whole page, not a per-user round trip, and
  never a live SF/Graph call). Green = a token is on file (last known, not verified this instant);
  gray = never connected; a tooltip shows the connected-as account and when. Each icon has its own
  small **Verify** button (`RefreshCw`, spins while in flight) that fires
  `POST /users/:userId/verify-connection` — the ONLY code path that makes a live probe on another
  user's behalf, and only for the one row clicked: it reuses `getSfConnection()`'s
  `conn.identity()` call and a `GET /me` Graph call, the exact same liveness checks
  `/auth/salesforce/status` and `/auth/microsoft/status` already run on a user's own My Settings
  page, just admin-triggered against someone else's stored token. Never fires automatically or in
  bulk — verifying 50 users would be 50 external API calls with no batch endpoint on either
  provider's side, so it stays a deliberate one-row-at-a-time admin action, audited as
  `user.verify_connection` (not destructive — read-only). Gated by the same `canManageUserAlignment()`
  helper Sales Team Alignment already uses (app admin, or an admin/team_admin sharing a team with
  the target user).
- Role Management — page-key permission matrix. Ordered to mirror the sidebar and Dashboard tab groups exactly; every page in the app has a row (v1.216). Note `hasPermission` treats an absent key as DENIED, so a page missing from the matrix is invisible, not open

**Integrations**
- Integrations — Okta / Salesforce / Microsoft Graph / Email / **Slack** status + connect. Slack *(moved here from its own standalone page, v1.232+)* is a global Bot token + Workspace URL card like every other row here — do not confuse it with the per-team Nudge Rules Slack Incoming Webhook (Nudge Rules, above), a separate, per-team delivery channel for nudge messages. *(v1.381+)* A **CRM features** card holds app-wide switches for optional CRM features: **Campaigns** and **Leads**, both on by default (see docs/history.md v1.381.0 / v1.382.0)
- **AI Assistant** *(v1.392+, App Admin only)* — replaces the old Azure OpenAI card. Providers live in `ai_providers`
  (kind `anthropic | azure_openai | openai | bedrock | foundry | gemini | xai | webhook`, model/deployment, secret encrypted with
  `encryptToken`, kind-specific endpoint/region/access key/resource/org, optional per-MTok prices, `isActive`, exactly one
  `isDefault`); per-kind fields come from `AI_PROVIDER_KIND_INFO` (`src/shared/ai.ts`). Settings are `system_settings` key
  `ai_settings` (`{enabled, monthlyBudgetUsd, budgetAlertSentFor}`, 30s cache in `services/ai/providers.ts`, cleared by
  `clearAiCache()` on write and after a restore). **Every AI call goes through `runAi()`** (`services/ai/gateway.ts`):
  switch → provider (`pickProviderRow`: the feature's route in `ai_feature_routes` if that provider is active, else the
  active default) → monthly budget → `callProvider()` (`services/ai/adapters.ts`; Anthropic/Bedrock/Foundry via the
  Anthropic SDKs, the rest over their HTTP APIs), and writes one `ai_requests` row per attempt (feature, provider, model,
  status, tokens, estimated cost, input hash; never the input). `aiAvailability(feature)` answers the same checks without
  calling anything, so screens can hide AI actions. Over budget: AI stops until the 1st, features fall back to no-AI, and
  App Admins get one `ai_budget_reached` email per month. The per-feature routing table shows only with 2+ active
  providers. Routes `/api/admin/ai/*` (settings, providers CRUD, set default, test, routes), audited `ai.*`
  (`ai.provider.delete` is destructive). Setup wizard step 8 is the same provider form (`AiProviderFields.tsx`,
  `/api/setup/test-ai-provider`, `/api/setup/ai-provider`). Azure endpoints still go through
  `assertAllowedAzureOpenAiEndpoint()`. *(v1.426+)* A **Webhook** provider (kind `webhook`) sends each call as a signed
  JSON POST to an admin-chosen URL (n8n, an AI gateway, a self-hosted model); contract in `docs/ai-webhook.md`. Its URL
  goes through `assertServiceUrl()` on save and every call (`allow_private_network` opts in to a private address), and
  the Setup wizard never offers it. *(v1.464+)* **Fetch latest models** on the provider form
  (`POST /api/admin/ai/models`, `services/ai/modelCatalog.ts`) lists models from the provider (typed or saved key) or
  the LiteLLM price list, with LiteLLM prices (built-in table as fallback); typed prices win and are saved. *(v1.467+)* **Usage this month** reads `GET /api/admin/ai/usage` (`services/ai/usage.ts`): grouped by feature, team or person, 20 requests per page, filters; a request's team is its charged `team_id`, else the requester's default team. *(v1.468+)* Each feature can be turned off (`ai_settings.disabledFeatures`, `isAiFeatureOn()`): the gateway answers it as `disabled`, so add any new AI feature to `AI_FEATURES` and give it a no-AI fallback. *(v1.471+)* `GET /api/ai/features` answers which features can run now (no provider call), so a screen hides an AI action that would only fail (My Notes does); give a new feature a `feature_about` / `feature_off_effect` line on the AI features card.
- **Event Webhooks** *(v1.428+, App Admin only)* — signed outbound POSTs for `activity.submitted`,
  `activity.crm_sync_failed`, `activity.outlook_deleted`, `nudge.sent`, `job.failed` and *(v1.431+)*
  `auth.suspicious_sign_in`, `user.disabled`, `ai.budget_reached`, `anomaly.found` (`src/shared/eventWebhooks.ts`),
  filtered by team and person, full contract in `docs/event-webhooks.md`. Raise an event with `emitEvent(type, data,
  scope)` / `emitActivityEvent()` (`services/webhooks/events.ts`; the scope names the event's teams and person): it only queues `event_webhook_deliveries` rows and never throws, so the action that
  raised it can't fail; the `event_webhook_worker` job sends and retries. A payload never carries a private meeting's
  title or any notes. Same signing and host rules as the AI Webhook provider (`services/webhooks/signing.ts`,
  `assertServiceUrl()`).
- Sales Team Alignment — SF User → team mapping
- **Gong** *(v1.452+, App Admin only)* — access key (default) or OAuth app, settings in `system_settings.gong_config`
  (`services/gong/`). Every Gong call goes through `gongRequest()` (`services/gong/client.ts`); the host is pinned to
  `*.api.gong.io`. Gong's key reads every call in the tenant, so ImpactIQ is the gate for who sees a transcript (plan:
  owner, people on the call, App Admins; Leaders only with the per-team switch). Daily `gong_user_sync` matches users by email.
  *(v1.453+)* Transcripts tab on the activity drawer: `gong_call_index` fills `gong_calls`; every transcript route checks
  `canReadTranscript()` (`services/gong/access.ts`) and suggestions/search only list calls the owner or caller was on.
  *(v1.456+)* `gong_auto_link` (`services/gong/autoLink.ts`) links a call on the same calendar meeting, or one strong
  match (85+, no rival 40+); an Unlink is remembered in `gong_link_dismissals`. `POST /api/webhooks/gong` takes Gong's
  RS256-signed webhook (key on the Gong card) and re-reads the call from Gong. Raw-SQL text arrays go through
  `textArray()` (`services/gong/sqlArray.ts`): drizzle expands `${array}` into a parameter list
  *(v1.457+)* AI Notes tab (`services/aiNotes/`, `/api/ai-notes`): owner-only Generate through `runAi()` with `teamId`
  (per-team switch and monthly limit, Admin → Workplace → AI Notes); reads only the owner's own notes; a note that read a
  private note is owner + App Admins only. Never part of the CRM payload
  *(v1.458+)* My Notes has a Written / AI switch (`GET /api/ai-notes/mine`: the caller's own activities, teams with the
  switch on); its right pane is `AiNotesTab` itself, so both views act on one table
  *(v1.459+)* Demo Data seeds Gong calls (`demo-gong-` ids), cached transcripts and AI Notes (`services/demo/gongFixtures.ts`).
  `services/gong/demo.ts` keeps them apart: demo-team activities see only demo calls and real ones never do, a demo
  transcript is never fetched from Gong, culls/disconnect/auto-link skip demo rows, and the demo team's AI Notes show
  without the AI Assistant but never Generate (`blockedReason: 'demo_data'`). Use `gongReadinessForTeam()`, not
  `isGongConfigured()`, for any new per-activity Gong check. *(v1.473+)* It also seeds Settings Profiles
  (`services/demo/profileFixtures.ts`: a starred Default, plus one per sample assessment); keep their custom section keys
  in step with the demo AI Note items
- CRM Historical Import *(moved here v1.216, was Monitoring)* — start / pause / reset the pre-ImpactIQ Salesforce Event backfill, dry run, relink, exclusion lists, estimate cap
- MCP Server — on/off kill switch + copy-paste config snippets (n8n, Claude Desktop, and, since v1.350+, a **claude.ai web (Connectors)** snippet — see below), combined connection-info card, and the MCP activity KPIs + tool-call log (the former standalone "MCP Activity" monitoring page was merged in here in v1.146)
- **App Updates** *(v1.332.0+)* — owner/repo/PAT for the pinned GitHub branch (`main`, fixed, shown but not admin-editable), self-fetching card like Slack. See §14b for the full trust-boundary writeup — App Admins can view this card; only the default admin can save/clear the token or trigger a live check

**Global**
- Teams / Subteams / Products / Calendars / Themes / **Communications** *(renamed from "Email Communications" v1.230)* — per-rule Active/Inactive toggle + customizable subject/body template per `email_rules` row, and *(v1.230+)* a read-only "Sending from: {{address}}" banner sourced from the same app-wide integration config `GET /api/admin/integrations/config` already exposes (SMTP or Graph App-Only `fromAddress`) so an admin can see which address every rule on the page actually sends from without leaving it. Scheduling's **Email admins on error** toggle (below) sends through this page's `job_failure_alert` rule — Active/Inactive-gated and template-editable like any other rule, seeded with no custom template so it uses the same default subject/body it always sent until an admin customizes it here.
- **Themes** *(architecture finalized v1.347.0)* — every color/logo/email-header combination is a
  row in `app_themes`. There is no separate "org default palette" mechanism of any kind — an
  earlier `system_settings`-based "Acme Brand Palette" singleton (colors + logos with no `id`,
  so it could never be a target of `teams.active_theme_id`) was retired and its data promoted into
  a real `app_themes` row by migration `0149_promote_palette_to_theme.sql`, a one-time,
  `WHERE NOT EXISTS (SELECT 1 FROM app_themes)`-guarded backfill: on a fresh install it seeds one
  `is_active = true` row named "Acme Brand" from the hardcoded defaults (renamed to "Default" by migration 0152, v1.371.0); on an install that
  already has at least one `app_themes` row (every real org at the time this shipped), it is a
  pure no-op — nothing is added or changed. **Invariant enforced server-side, not just by
  convention: the app always has ≥1 theme, and exactly one is Active.** `PATCH /api/admin/themes/:id`
  rejects `isActive: false` outright — the only way to change which theme is active is to activate
  a *different* one, which atomically deactivates the rest in the same request.
  `DELETE /api/admin/themes/:id` rejects deleting the last remaining theme and rejects deleting the
  currently-active theme (`errors.themes.cannot_delete_last` / `.cannot_delete_active` /
  `.use_activate_another`). Any team can be assigned any theme via its own `active_theme_id`
  (Admin → Team Management's per-team Theme dropdown, docs/history.md v1.346.0's own fix ensures its "Inherit
  org default" option names the real current default); a team with no theme assignment inherits
  whichever theme is currently Active. The Active theme is also what an unauthenticated visitor
  sees on the Login page, before any team context exists. `GET /api/themes/active` (used by both
  the Login page and `loadActiveThemeEmailConfig()`/`serveThemeLogo()` for outbound email
  branding) is now a single, uniform lookup — no more 3-tier "active theme → palette → hardcoded"
  fallback chain, since there's only ever the one kind of thing to look up.

**Workplace** *(v1.249+)*
- **Flight Deck** — team-configurable login onboarding checklist. See §14a below for the full model.
- **Announcements** *(v1.349+)* — team-scoped broadcast messages. See §14c below for the full model.
- **Terminology** *(v1.446+, App Admin only)* — the org's word for an evaluation (§7).

**Monitoring** *(App Admin only)*

Admin submenu categories are collapsible/expandable; only "Monitoring & Audit" is expanded by default, and **App Health** is its first item and the default section shown when opening Admin.

- **App Health** *(v1.146+)* — `/admin/db-health`. Live Postgres database size, per-table row counts + total/index size + sequential-vs-index scan counts (amber-flagged when a sizeable table is read mostly via seq scans = likely missing index), slowest queries via `pg_stat_statements`, connection used/max, app uptime/memory. *(v1.440+)* A **System Health Overview** sits on top (`GET /api/admin/health-overview`, `services/health/overview.ts`): Healthy / Warnings / Errors counts and eight tiles (Database, Background Jobs, Queues, Integrations, Email, AI Assistant, Data & Backups *(v1.444+)*, App Server), auto-refreshing, each linking to the page with the detail. Tiles only read data the app already keeps plus `email_deliveries` (every send through `sendEmailViaConfigured()`, body never stored; pass `category` on a new sender) and the scheduler's in-memory heartbeat (`getJobHeartbeats()`, which catches a job whose loop stopped, something `job_runs` can't show). No live CRM / Graph / AI calls. Status `off` = not set up and counts as neither. Each tile is try/caught. CRM failure counts match CRM Sync → Issues (resolved ones excluded). `/ready` (readiness, runs `SELECT 1`) is for load balancers and uptime monitors; Docker's HEALTHCHECK stays on `/health` so a database outage never causes restart loops. *(v1.444+)* Integration call results come from the clients themselves: a new integration client calls `recordIntegrationCall()` (`services/health/integrationStatus.ts`), and a per-user token refresh failure calls `markUserIntegrationFailed()`. A new retention cull reads its period from `RETENTION_POLICIES` (`services/health/retention.ts`) so App Health checks the same number. A Readiness check panel reminds admins what to point at `/ready`
- Audit Log — *(v1.302+)* Action filter dropdown and the server's `AuditAction` type both derive
  from `src/shared/auditActions.ts`, the single source of truth for every action the app logs
  (previously hand-duplicated on each side; the client list had drifted to 17 of 47 real
  actions). Target-name resolution (`GET /admin/audit`) covers `team`/`user`/`subteam`/`activity`
  by id lookup, plus `sf_field_mapping` via a label built from the row's own logged `meta`
  (`"appField → sfFieldApi"`) since a mapping has no standing name and a delete's target row is
  already gone by read time. Other `targetType` values (`integration`, `historical_import`, etc.)
  use literal, already-readable string ids and don't need resolution. *(v1.330+)* A KPI row —
  styled like CRM Sync's — sits above the table: **Total Events**, **Destructive Actions**, and
  **Distinct Actors** are all a rolling 7-day window (a week is the natural cadence for admin
  config changes, distinct from CRM Sync's own 24h, which suits a busy sync worker);
  **Most Active Admin** names the top actor by count in that same window; **Retention Horizon**
  is the one all-time figure — age of the oldest retained row against the configured
  `AUDIT_EVENTS_RETENTION_DAYS`. All five come from a dedicated `GET /admin/audit/summary` route
  with its own aggregate queries — the page's own `GET /admin/audit` list is capped at 100-200
  rows and would silently undercount a real weekly figure. "Destructive" is a curated allowlist
  (`DESTRUCTIVE_AUDIT_ACTIONS` in `src/shared/auditActions.ts`), not a suffix heuristic on the
  action string — a heuristic would misclassify `activity.outlook_deleted.keep` (contains
  "deleted" but is the non-destructive KEEP branch) and `work_week.reject` (a workflow decision,
  not data loss).
- Login History — successful + failed authentications. *(v1.330+)* A KPI row above the tabs:
  **Failed Login Rate**, **Suspicious Logins** (new-IP flags, §4's `isSuspicious`, with an
  "Alert not sent" sub-count when the new-location notify email didn't go out), **Top Failure
  Reason**, **SSO vs. Password** split, and **Accounts Under Attack** (distinct accounts with
  3+ failed attempts in the trailing 24h). All five are computed client-side from the same
  capped recent-events fetch the page already loads (bumped from 200 to the server's own max of
  500, matching CRM Sync's own convention) — no new backend route needed. One non-obvious
  correctness point: MFA is required on every password login in this app (§4), so a *successful*
  password-path sign-in is never actually tagged `method: 'password'` — that literal only appears
  on failed attempts, before MFA. Successful logins land as `'okta'`/`'azure'` (SSO) or
  `'mfa'`/`'totp'`/`'backup_code'` (password path, tagged by which MFA step closed it out) — the
  SSO-split KPI checks membership in the SSO set, not a `!== 'password'` test, which would have
  silently always read "100% SSO."
- **CRM Sync** *(v1.216+, expanded v1.259–v1.261)* — merged Sync Issues + Sync History. Health KPI row over an Issues / History toggle. History now captures every Salesforce write the app makes, not just the activity writeback worker — note pushes, the Engineer Notes prepend-update, Assigned SE writes, and Opportunity/Evaluation field edits all show up with success/failure, the full JSON payload, and a Source column/filter identifying which subsystem made the write (v1.259). Issues gets a **Resolve** button that marks a failure manually handled without retrying (reopens automatically if it fails again), an Open/Resolved/All status filter with resolved rows shown de-emphasized alongside who resolved them and when, and the KPI relabeled "Open/Resolved Issues" as `{{open}}/{{resolved}}` (v1.261); clicking Resolve updates the header/badge immediately rather than waiting for a tab switch (v1.263)
- **Activity Health** *(v1.258+)* — triage queue for the free-text "Why Meeting?" reasons a contributor can capture when logging a Meeting-type activity (§7). App Admins mark each captured reason Ignore / Will Watch / Addressed, with reviewer + timestamp
- **Nudge History** *(team-scoped since v1.324; was App-Admin-only/tenant-wide before)* —
  every nudge delivered, joined to the originating rule's `name` (§11). Team-scoped like every
  other Nudge Rules screen: team_admin/admin see their own team by default, App Admins can switch
  teams or view **All Teams** (tenant-wide, matching the pre-v1.324 behavior) via the header's
  TeamSelector — `requireGlobalAdmin`'s baseline only proves "an admin somewhere," so the route
  separately 403s a non-app-admin's request for a specific team they don't belong to. A **History
  / Dismissals** tab switcher (icons reused from Nudge Rules/the old Nudge Dismissals page) puts
  the former standalone Nudge Dismissals page here as the second tab, unchanged internally except
  it now shows the rule's `name` instead of a generic per-trigger-type label; Dismissals has no
  tenant-wide route (it resolves via `team_members`, inherently per-team) so that tab only appears
  once a specific team is active, not under All Teams. A 4-KPI row (Top Nudge / Top User / Most
  Snoozed Nudge / Top Snoozing User with avg days snoozed as a sub-stat), styled like CRM Sync's
  KPI cards, sits above the tabs — scoped to the current team, all-time. The two snooze-based KPIs
  read `GET .../nudge-dismissals?includeExpired=true`, a new opt-in flag on the existing Dismissals
  route that skips both the expiry filter and the "latest row per (user, rule) pair" collapse the
  Dismissals tab itself relies on — the KPIs need every historical snooze counted (an already-
  expired one is still evidence someone snoozed it), not just what's currently active. The existing
  **Trigger** filter/column is unchanged; a new, separate **Nudge** filter/column (keyed by
  `nudgeRuleId`, labeled by `ruleName`) sits alongside it, since a trigger type can now be shared
  by multiple named rules and the two answer different questions
- (moved v1.216) **CRM Historical Import** now lives under **Integrations** — App Admin only. Start / pause / reset the pre-ImpactIQ Salesforce Event backfill, run a no-write dry run to check user + type match rates first, trigger an SF-free relink, and review per-slice run history plus the SF Type values that resolved to no ImpactIQ activity type. v1.215 adds the creator/owner exclusion lists with a top-creators discovery panel and confirmed purge, plus the all-day estimate cap
- **Scheduling** *(v1.138+, editable v1.227+, Run Now v1.283+)* — status table for every registered background job (refresh_opp_snapshots, refresh_opp_coverage, refresh_historical_opps, historical_backfill, writeback_worker, notes_push_worker, digest_worker, weekly_recap_worker, sync_audit_cull). Shows last run, duration, status pill, message, and a per-job "Email admins on error" toggle (max one email per admin per job per day via `job_config.last_error_email_at`). Every job now runs through the shared `src/server/services/jobs/scheduler.ts` (`scheduleJob()`), which reads `job_config.enabled`/`job_config.interval_ms` on every tick — an admin can turn a job off or change its cadence with no server restart, taking effect from that job's next natural fire. Cadence is only editable for jobs on a plain interval (a pencil icon marks them); `digest_worker` and `weekly_recap_worker` keep their internal tick interval fixed, but *(v1.230+)* their target local send time — daily hour for digest, day-of-week + hour for weekly recap — is admin-editable via `job_config.schedule_hour`/`schedule_minute`/`schedule_day_of_week` (null = the original 08:00 / Friday-PM defaults), read fresh each tick so a change takes effect at the job's next natural fire with no restart. `historical_backfill` isn't scheduled at all (it's admin-triggered from CRM Historical Import). Every job records a run row only when it did real work or errored — never on a no-op tick. `digest_worker`/`weekly_recap_worker` established this gate first (60s/5min ticks that just check a clock/window); the same `processed > 0` (or error) gate was extended *(v1.229+)* to the three 30s queue pollers — `writeback_worker`, `outlook_writeback_worker`, `notes_push_worker` — after logging every quiet tick unconditionally briefly shipped in v1.227.0 and filled `job_runs` with ~2,880 no-op rows/day per poller, dwarfing the volume the original two jobs were gated to avoid. A future job on a fast interval should default to this same gate rather than reintroducing always-log. *(v1.283+)* Every job except `historical_backfill` (which has its own dedicated trigger under CRM Historical Import) gets a per-row **Run now** button — `scheduleJob()` registers each job's task in a lookup keyed by `jobKey` (`src/server/services/jobs/scheduler.ts`), and `POST /api/admin/scheduling/:jobKey/run-now` invokes the exact same task the scheduler would call on its next tick, so it can never drift from what the job actually does on schedule. On a clock-gated job (`digest_worker`/`weekly_recap_worker`) Run Now does NOT bypass the "is it the right send window" check — it re-runs the same task, so it only visibly does something if that check currently passes. *(v1.328+)* That correct-by-design behavior read as a broken button in practice — clicking Run Now outside the send window produced no visible change and no explanation, reported as "it says it ran now but no update." The route now records the job's latest `job_runs.startedAt` before invoking the task and again after, and returns `recordedNewRun: false` when the two are identical — i.e. the task ran but the clock gate itself decided there was nothing to do, as opposed to `recordedNewRun: true` (a real run happened) or an error. The Scheduling page renders this as a third, distinct amber "nothing to do" pill (`Clock` icon) alongside the existing green success and red error states, with a tooltip explaining it's not the scheduled send window yet rather than implying success either way. *(v1.329+)* Two direct follow-ons, once it became clear the send-window check is evaluated **per-user, in each user's own local timezone/day-of-week** — not one global clock — so "when will it run" has no single obvious answer. First, a new **Send Window** column shows the raw configured schedule itself ("Daily @ 08:00 (user's local time)" / "Fridays @ 17:00 (user's local time)"), moved out of the Cadence column entirely — Cadence now only ever shows the scheduler's own tick interval ("60s tick" / "5min tick"), since folding the two together into one label for these two jobs is exactly the ambiguity that produced the original "Run Now did nothing" report. `entry.cadence` for these two jobs was shortened accordingly; the schedule display + edit UI (pencil icon, weekday/hour/minute inputs) moved to the new column verbatim, no state changes needed. Second, on a noop the route now also computes the real, honest ETA: `getNextDigestEtaMinutes()`/`getNextWeeklyRecapEtaMinutes()` (`services/notifications/digest.ts`/`weekly-recap.ts`) query every currently-enabled user's timezone and last-sent timestamp and return the earliest minutes-from-now that ANY one of them will next qualify — the true next moment the job could do real work, not a guess against one reference timezone (a single-timezone countdown was considered and rejected: it could hit zero while some users' local clocks haven't reached the target time and others already have, guaranteeing nothing). The pure delta arithmetic (`computeNextDigestDeltaMinutes`/`computeNextWeeklyRecapDeltaMinutes`) is unit tested (`etaMath.test.ts`) independent of the DB query. The client renders this as a live-ticking countdown ("next possible send in 2h 14m") under the noop pill, computed once as a fixed target instant so it counts down against the wall clock rather than being re-derived (and drifting) on every render. *(v1.330+)* A KPI row above the table, styled like CRM Sync's: **Jobs in Error** (latest run status per job), **Jobs Disabled**, **Never Run** (registered but no `job_runs` row at all — `historical_backfill` excluded, since it's admin-triggered and genuinely never runs on its own), **No Error-Alert Configured** (`notifyOnError` off), and **Failed Runs (7d)**. The first four are computed client-side from the same `registry`/`latest`/`config` payload the table already renders; the fifth needs a dedicated `count(*)` query — the existing `recent` list is capped at 20 rows total across every job, not enough to count reliably since one noisy job can push another's real errors out of that window

MCP Activity is no longer a standalone Monitoring page — it lives on the MCP Server page under Integrations (see above).

---

## 14a. Flight Deck — Login Onboarding Checklist *(v1.249+)*

A team-scoped checklist shown in a welcome modal after login (Admin → Workplace →
Flight Deck). Three tables: `flight_deck_items` (label, tooltip, icon, optional
icon color, up to 5 screenshots stored as data-URI strings — same convention as
`app_themes` logo upload, no separate file storage stood up for this — link type
`app_page` or `external_url`, `is_preset` badge-only flag, sort order, active
flag), `flight_deck_item_translations` (per-locale label/tooltip override,
falls back to the base row when missing — same fallback contract as
`nudge_rule_translations`), and `flight_deck_completions` (per-user, per-item
`PRIMARY KEY (user_id, item_id)` — persists across logins even as an admin adds
new items later, so checking off item 3 today isn't lost when item 4 is added
next month; deleting the parent item cascades).

- Up to 10 items can be **active** at once; beyond that, new/reactivated items
  land inactive with a heads-up instead of being blocked outright — an admin can
  still create as many as they want.
- One boolean, two entry points: `users.show_flight_deck` (default `true`) backs
  both the modal's "Don't show again" checkbox and a My Settings → Preferences
  toggle to re-enable it. A header-bar button (between the days-left pill and the
  language picker) reopens the checklist on demand regardless of that flag.
- Icon picker is shared app-wide (Nudge Rules, Activity Types, Teams, Templates,
  Flight Deck) and searches the full lucide icon library, not a shortlist.
- Each checklist item's label/icon area is inert; a dedicated link button on the
  right is the only click target for navigation, so the label and a
  screenshots-expand toggle can safely coexist on the same row.
- 5 default (`is_preset`) items are seeded per team, including "Connect your
  Outlook account." **Backfill footgun:** the original backfill only ran for
  teams with zero Flight Deck items, so a team that already had one custom item
  never received the defaults. Fixed by checking each default individually
  (idempotent per-item), plus an admin "Add Default Items" button to re-run this
  for any team on demand — don't reintroduce an all-or-nothing backfill check
  like the original.
- Modal shows the team's theme logo (120×35px, light/dark aware) top-right, same
  as every other page header; it has no X close button by design — "Let's Get to
  Work" or clicking outside are the only dismiss paths.

---

## 14b–14d. App Updates, Announcements, Backup & Restore — see `docs/features.md`

- **App Updates** *(v1.332+)*: compares `APP_VERSION` with `CHANGELOG[0]` on the pinned `main` branch (safe parser,
  never `eval`). Only the default admin can save the GitHub token, check now, or schedule a maintenance window. A
  scheduled restart only exits the process (`restart: unless-stopped` brings it back); it never pulls or rebuilds code.
- **Announcements** *(v1.349+)*: team / subteam / user targets, synced into `notifications` (`kind: 'announcement'`,
  `team_id` null) and shown in the header banner and bell. CRUD lives on `teamsRouter`, not `adminRouter`, so plain
  Leaders can reach it (see Known traps, §18).
- **Backup & Restore** *(v1.375+)*: App Admin only; one gzip'd file of every `public` table (no env vars, no sessions),
  preview first, typed `RESTORE`, one transaction, schema version must match exactly.



---

## 15. i18n Requirements (MANDATORY)

**Every user-facing string must go through `t()`**. No hardcoded English strings in components.

```typescript
// CORRECT
const title = t('activity.form.title_label')

// WRONG — flagged in code review
const title = "Activity Title"
```

Supported languages: `en`, `de`, `fr`, `es`, `ja`, `pt`, `it`
Translation files: `src/client/i18n/locales/{lang}/translation.json`

**All seven locale files must be updated in lockstep.** Any PR that adds
a new user-facing string, renames a key, or edits copy MUST add or
update the same key in every one of the six files — not just `en`.
Do not rely on the `t(key, 'English default')` fallback for
non-English locales. That pattern silently ships English text to
Spanish / German / French / Japanese / Portuguese / Italian users because
i18next resolves the missing key to its `defaultValue` argument, not
to the `en` fallback locale. If you're not fluent in a language,
translate with the same tool you'd use for a customer email and mark
the entry with a `// TODO(i18n): review` comment above the file only
if genuinely uncertain — never leave the English string as the "es"
value.

Verification before commit: `grep -c '"<new_top_level_key>"' src/client/i18n/locales/*/translation.json` must return `1` for every locale. If a locale lacks the key, the audit fails.

**Full-repo structural check** *(v1.312+)*: `python3 scripts/check-i18n-parity.py` flattens all
7 `translation.json` files to dot-path keys and diffs every locale against `en`, reporting both
missing keys (in `en`, absent in a locale) and extra keys (the reverse gap — a locale defines a
key `en` itself never got). Run this after any batch of i18n edits, not just a single new key; it's
what closed the 149-key gap found by an earlier full audit (docs/history.md v1.312) down to zero. **This check
is structural only — it proves every locale HAS a value for every key, not that the value is an
actual translation.** A locale file can pass it while holding literal English text as the stored
value for a key that does exist (found independently during the v1.312 pass, affecting 314 keys
across the 6 non-English locales — see §18's Deferred/Roadmap note). Spot-check translated content
for real language, not just key presence, especially in a locale/section you haven't touched
recently.

**The CRM's name is a variable, never literal text** *(v1.403+)*: write `{{crm}}` (or `{{crmShort}}` where English
says "SF") in every locale; i18next fills it from the active CRM with no extra `t()` argument (§9 "CRM name in every
string"). Add a `_<providerId>` context variant only when the wording differs beyond the name, and pass
`context: useCrmLabelContext()` for it.

The same rule extends to server-side error message keys returned in `{ error: 'errors.foo.bar' }` responses — the client renders them via `t()`, so the key must exist in all seven locales.

---

## 16. Dark Mode Requirements (MANDATORY)

- Tailwind CSS `dark:` variant throughout — no exceptions
- shadcn/ui dark mode native support — leverage it
- Theme toggle persisted to DB in user preferences
- Default: respect OS `prefers-color-scheme`
- No inline styles — all theming via Tailwind classes and CSS variables

---

## 17. Deployment Configuration

### Environment Variables
```env
# App
NODE_ENV=production
PORT=3000
APP_URL=https://impactiq.internal.example.com

# Database (containerized Postgres)
DATABASE_URL=postgresql://user:password@postgres:5432/impactiq

# Okta
OKTA_DOMAIN=<your-okta-domain>
OKTA_CLIENT_ID=<client-id>
OKTA_CLIENT_SECRET=<client-secret>
OKTA_REDIRECT_URI=<app-url>/auth/callback

# Salesforce
SF_CLIENT_ID=<connected-app-client-id>
SF_CLIENT_SECRET=<connected-app-client-secret>
SF_REDIRECT_URI=<app-url>/auth/salesforce/callback
TOKEN_ENCRYPTION_KEY=<32-byte-hex-key>   # production refuses the .env.example "change-me" placeholders (v1.476+)

# Microsoft Graph
MS_CLIENT_ID=<azure-app-client-id>
MS_CLIENT_SECRET=<azure-app-client-secret>
MS_TENANT_ID=<azure-tenant-id>

# AI providers are configured in the app (Admin → Integrations → AI Assistant, §14),
# never through env vars. AZURE_OPENAI_* was removed in v1.392.0.

# Performance / observability (all optional — defaults shown)
DB_POOL_MAX=10                        # max Postgres pool connections
DB_STATEMENT_TIMEOUT_MS=30000         # per-query statement_timeout
DB_IDLE_TIMEOUT_S=<seconds>           # idle client timeout
DB_CONNECT_TIMEOUT_S=<seconds>        # connection acquire timeout
DB_QUERY_LOG=0                        # 1 = echo SQL to logs
SLOW_REQUEST_MS=1500                  # log HTTP requests slower than this
REQUEST_TIMING_LOG=0                  # 1 = log timing for every request
DASH_MAX_WINDOW_DAYS=1095             # cap "All time" dashboard ranges (~3 years)
TRUSTED_PROXY_HOPS=                   # proxies in front of the app (0-3); overrides Admin → Rate Limiting (v1.424+)
SETUP_TOKEN=                          # optional, 16+ chars; the setup wizard's token instead of a random one (v1.425+)

# Retention culls (run in the 6h housekeeping sweep)
AUDIT_EVENTS_RETENTION_DAYS=1095
JOB_RUNS_RETENTION_DAYS=90
AI_REQUESTS_RETENTION_DAYS=395        # AI Assistant usage log; added v1.392.0
EVENT_WEBHOOK_DELIVERIES_RETENTION_DAYS=30  # Event webhook delivery log; added v1.428.0
EMAIL_DELIVERIES_RETENTION_DAYS=30          # Outbound email delivery log (App Health); added v1.440.0
ATTACH_RATE_HISTORY_RETENTION_DAYS=1095
LOGIN_EVENTS_RETENTION_DAYS=60        # Login History (§14); added v1.364.0
ACTIVITIES_ARCHIVE_DAYS=              # off by default; sets is_archived=true, never hard-deletes

# Backup & Restore (§14d) — optional
BACKUP_MAX_UPLOAD_MB=2048             # largest backup file Admin → Backup & Restore accepts

# Error tracking (v1.414+) — optional, off unless SENTRY_DSN is set. Sentry or self-hosted GlitchTip.
SENTRY_DSN=
SENTRY_ENVIRONMENT=production         # defaults to NODE_ENV
```

> **Running more than one app replica** *(v1.414+)*: every scheduled job tick takes a Postgres advisory lock
> (`services/jobs/jobLock.ts`), so only one replica runs a given job at a time. Still per-process: the in-memory rate
> limiter (limits apply per replica) and pending Backup & Restore uploads (the preview and the apply must hit the same
> replica, so use sticky sessions or one replica for restores). The image runs as `USER node`, so `PORT` must stay
> above 1024.

> **Health endpoints** *(v1.440+)*: `/health` is liveness (process serving, never touches the database) and is what the
> Dockerfile HEALTHCHECK uses; `/ready` is readiness (503 until `SELECT 1` answers within 3s). Point a load balancer or
> uptime monitor at `/ready`, never Docker's HEALTHCHECK, or a database outage turns into a restart loop.

> App Health's slow-query panel needs `pg_stat_statements`. The docker-compose Postgres
> preloads it via `shared_preload_libraries`; run
> `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` once against the database.

### Docker
- `docker-compose.yml` includes app container + Postgres container
- Single `Dockerfile` for the app
- Compatible with Dokploy OR a bare Azure VM from the same image

---

## 18. Phase Boundaries

### Shipped

Release-by-release history (v1.145 to today, with the reasoning and lessons for each change) lives in
`docs/history.md`. Add one bullet there for every release, alongside the `src/shared/changelog.ts` entry (§20b).

### Known traps (read before changing related code)

Lessons from the release history (`docs/history.md` has the full story for each):
- **Migrations**: never edit an existing file; every new `.sql` needs its `_journal.json` entry or it silently never
  runs. Migrations apply one file per transaction (`db/migrator.ts`), never through drizzle's own `migrate()`, so an
  `ALTER TYPE ... ADD VALUE` is committed before later files use it. CI migrates an empty Postgres on every PR.
- **Aggregates come back as strings.** The `postgres` driver returns `count(*)`/`sum()` (bigint/numeric) as strings,
  and `sql<number>` is only a type. Wrap in `Number(...)` before comparing. pglite returns numbers, so tests won't catch it.
- **No `Date` inside a raw `sql` template.** The `postgres` driver can't bind it (pglite can, so tests pass); pass
  `d.toISOString()` with `::timestamptz`, or use drizzle's `gte()`/`lt()` helpers, which convert it.
- **Gate vs. scope.** A route's role check and its query's team scoping are separate; verify both. Never trust a
  client-supplied `teamId` without `getAccessibleTeamIds()` / an ownership check on the nested resource.
- **`adminRouter`'s blanket gate excludes plain Leaders.** Put Leader-reachable routes on `teamsRouter` or another router.
- **Where new routes go** *(v1.416+)*: admin routes in `routes/admin/<area>.ts` (mounted behind the gate in `admin.ts`),
  dashboards in `routes/dashboards/<group>.ts` (shared helpers in `shared.ts`), auth in `routes/auth/<provider>.ts`.
  Don't grow the parent files again.
- **Team assignment uses junction tables** (`keyword_rule_teams`, `nudge_rule_teams`, `crm_field_mapping_teams`), not the
  rule's own `team_id` column.
- **Zod strips unknown keys.** A new theme color must also be added to `themeColorsSchema` in `admin.ts`.
- **Fetching a URL an admin configured** *(v1.477+)*: use `safeFetch()` (`services/net/safeFetch.ts`), never a bare
  `fetch()`. It checks the URL, re-checks every address at connect time (undici dispatcher, so DNS rebinding can't slip
  past) and never follows redirects. Pass `allowPrivateNetwork` only where the admin opted in. Tests that stub the global
  fetch mock `safeFetch` to delegate to it (see `services/ai/webhook.test.ts`).
- **Query params**: read with `typeof x === 'string' ? x : undefined`, never an `as string` cast. Escape SOQL literals
  with `safeSoqlLiteral()`.
- **Client fetches on a changing key** (week, user) need a stale-response guard; `useEffect` deps must be primitives,
  not a `Date` a hook recreates each render.
- **Locale files are CRLF**; scripted edits must keep that. Re-scan after a batch translation instead of trusting the
  script's own count.
- **No organization names** *(v1.473.1+)*: the repo is public-facing, so customer or employer names never go in code,
  comments, docs, seeds or tests. CI runs `scripts/check-banned-terms.py` (hashed term list); use "the reference org"
  or Acme-style placeholders.
- **The world-map watermark div** (Admin, Settings, Guide, How to Use) has broken six times; check top and bottom of a
  long page at wide and narrow widths, light and dark, after any change to it.


### Deferred / Roadmap

- Archival management UI (records past 2-year retention)
- CriteriaIQ-TVW integration
- Lead/Marketing linkage extensions in Salesforce
- CloudLAB compute + travel spend in Cost calculations (banner already visible on Most Expensive / User Leaderboard)
- **Historical import v2** — admin editor UI for `sf_historical_type_map` (v1.214 ships the table and resolver but surfaces unmapped SF Types read-only), optional `EventRelation` (invitee) import so SE-attended meetings owned by an AE are attributed correctly, and a recurring-event filter
- **MCP server v2 (writes)** — `mcp:write` scope + `activities.create`, `activities.submit`, `notes.create`, `salesforce.suggestion_override`. Gated on expanding the audit-log enum to cover activity/note mutations and adding a `via` (`session|apikey|mcp`) column to `audit_events`. See `docs/mcp.md` Roadmap for full tool list and rationale
- **MCP server v3 (governance & scale)** — per-tool ACL admin matrix, Redis-backed rate limiter for multi-instance deploys, Cowork connector catalog listing, UI-configurable per-key quotas
- **Nudge via Microsoft Teams** — designed, not built (§11 has the recommended approach: a per-team Incoming Webhook mirroring the existing Slack delivery pattern). Blocked on confirming which webhook payload format this org's Teams tenant actually supports before writing code
- **CRM switch-over (Salesforce → HubSpot on an existing install)** — not built. The CRM lock
  (`crmProviderChangeAllowed()`, §9) refuses a switch once CRM-linked data exists, and nothing can
  clear or move those links, so HubSpot is only reachable on a new install or one that never linked
  to Salesforce (known limit, `docs/crm.md` §3.5). Needs a design decision before code: either a
  **reset** (admin clears or archives every CRM link: activity `crm_*` ids, write-back record ids,
  attached tickets, `crm_historical_*` rows, CRM field mappings and user links, keeping the
  ImpactIQ activity data itself) or a **migration** (map Salesforce Account/Opportunity/Contact ids
  to the HubSpot Company/Deal/Contact records an admin's own Salesforce → HubSpot migration
  produced, then re-link). Either path must run in one transaction, be audited as destructive,
  require a typed confirmation like Backup & Restore's, and recommend a backup first. A
  migration is far more useful but depends on the org's own id-mapping export.
- **App Updates: automatic redeploy — designed (`docs/deploy-agent-plan.md`), not built.** The
  maintenance-window countdown/announcement + self-restart shipped in v1.333.0 (§14b's Phase 2)
  deliberately does NOT pull code, rebuild, or swap the running container — self-restarting only
  puts a newer version in place if the admin already staged a rebuilt image out-of-band first.
  Actually triggering that build-and-deploy step from inside the app needed a real decision:
  Docker-socket access in the app's own container (equivalent to root on the host) and a
  specific host's proprietary deploy API (Dokploy, reintroducing the host assumption Phase 1 was
  built to avoid — and this org doesn't use Dokploy anyway) were both discussed and rejected.
  The design settled on instead: **App Updates Phase 3, a small standalone agent program that
  runs outside the app's own container and polls the app for an admin-approved deploy intent**,
  rather than the app ever calling out to trigger anything — a compromised app process can at
  most write inert "please deploy commit X" data, never execute or force a deploy itself, and the
  agent has no listening port anything can reach to make it act sooner than its own clock. Full
  architecture (data model, auth, routes, the agent's poll loop, host-hardening options, and a
  phased 3a–3d build order) is written up in `docs/deploy-agent-plan.md` — read that file before
  starting this work rather than re-deriving the design. Two decisions the user already made
  that any implementation must honor: **no auto-rollback** on a failed deploy (alert a human
  instead), and the plan supports **either** a bare-host systemd unit or a Docker-sidecar shape
  for the agent, host choice deferred to actual rollout. Not started — needs explicit sign-off to
  begin Phase 3a before any code gets written.


---

## 19. Code Conventions

- All components TypeScript — no `.jsx` files
- Zod schemas defined server-side, shared to client via `src/shared/schemas/`
- API routes REST: `GET /api/activities`, `POST /api/activities`, etc.
- All API responses: `{ data, error, meta }` envelope
- Server-side role check on EVERY protected endpoint — no exceptions
- No `any` types — use `unknown` and narrow properly
- Drizzle migrations in `drizzle/migrations/` — never modify existing
- Seed data in `drizzle/seed.ts` — default team, activity types, SF mappings, rules
- Admin edit forms with several groups of fields use `components/admin/FormSection.tsx` *(v1.472+)*: colored
  collapsible sections with a closed-state summary, `FieldLabel required` for a red `*`, and `FormSaveBar` naming empty
  required fields (User Management and Team Management are the reference)

---

## 19b. Dropdown Convention (MANDATORY)

Every user-facing dropdown that lives OUTSIDE a form (dashboard header
filters, page-level toggles, popover pickers) must use the compact chip
components in `src/client/components/ui/`:

- `<SingleSelect>` for one-value pickers (e.g. dashboard filter row's
  "Team member", the Cost per ACV "Show Costs In" currency selector).
- `<MultiSelect>` for multi-value pickers (e.g. dashboard "Products").

Both render as a small pill (label chip + chevron), open a portal-based
popover so ancestor `overflow` can't clip them, close on outside-click
or outside-scroll, and share the same border / padding / typography
tokens so the app reads as one visual system.

Native `<Select>` is allowed ONLY inside form contexts where alignment
with `<Input>` height matters (Settings, Admin edit modals). Never mix
the two styles in a single header row.

Labels used by chip pickers must be Title Case ("Show Costs In", not
"show costs in"), because the chip renders the label inline before the
value: `Label: value`.

**Grouped dropdowns get a group-header "select all" checkbox** *(v1.276+)*
— every grouped `<MultiSelect>` (Subtype, Sales Stage's Legacy Stages, any
other grouped filter) lets the admin/leader check an entire group from its
header instead of only one item at a time; `Check`/`Minus` icons distinguish
all-selected from partially-selected.

**Portal positioning must clear the sidebar** *(v1.266 fix)* — a filter
dropdown opened near the left edge previously clipped behind the sidebar
z-index; every chip picker now renders above everything else on the page,
same as every other dropdown in the app. If you build a new portal-based
popover, verify it against a filter row near the left edge, not just center
screen.

## 20. TopHeader / Brand Logo Bar (MANDATORY on every page)

`<TopHeader />` is rendered inside `PageShell` in `src/client/App.tsx` and automatically
appears on every page wrapped by `PageShell`. It shows the configured brand logo
(light/dark variant) in the top-right of the main content area when a logo is set.

**Rule:** Every new page MUST be routed inside the `<PageShell>` wrapper in `App.tsx`.
Do NOT create standalone pages that bypass `PageShell` — they will be missing the brand
logo bar, the connection toast, and the sidebar.

The only pages that legitimately bypass `PageShell` are `/setup` and `/login` (pre-auth).

**App shell, VectorIQ parity** *(v1.420+)*. Sidebar pages live in `lib/appPages.ts` (`APP_PAGES`, with a `section`
heading and Role Management page key), and Admin sections in `lib/adminSections.ts` (categories, icons,
`canOpenAdminSection()`). The sidebar, the Admin page and the header's global search (`components/ui/global-search.tsx`,
Ctrl/Cmd+K) all read these, so a new page or Admin section is added there once. Other rules:
- **Help links.** The header's ? opens How to Use ImpactIQ at the section for the current page (`lib/howToUse.ts`,
  `howToUseSectionForPath()`). The support mailbox is the envelope icon beside it.
- **Admin URLs.** The open Admin section is in the URL (`/admin?section=<key>`), so link to a section that way.
- **Unknown paths** render `pages/NotFound.tsx`.
- **Printing** hides the sidebar, header and banners (`print:hidden`), lets every scroll container grow
  (`index.css` `@media print`), and prints in light mode (`usePrintInLightMode`).
- **Search API.** `GET /api/activities/search?q=` returns only the caller's own activities.
- **Search scope** *(v1.421+)*: search also lists dashboards (`lib/dashboardTabs.ts`, the same list and grants as the
  Dashboard picker; open one with `/dashboard?tab=<key>`), the Guide's activity type cards and Distinctions
  (`lib/activityTypeGuide.ts`, `/guide#guide-type-<id>`), and the text of How to Use ImpactIQ. Every group uses the
  same Role Management key as the page it links to, so a result never points at a page the user can't open.

---

## 19c. Icon-before-label convention (MANDATORY)

Every user-facing pill / badge / button that carries a text label MUST
lead with a lucide icon (or spinner when a task is pending). Consistency
matters more than perfect symbolism — pick the most-obvious lucide glyph
and stick with it, but do not ship a label without one.

Applies to:
- Status badges: Active / Inactive / Draft / Submitted / Connected /
  Not configured / Failed / Synced → `CheckCircle2` / `CircleSlash` /
  `Clock` / `Send` / `Plug` / `PlugZap` / `XCircle` / `CheckCircle2`.
- Buttons in headers or row-level actions: Save / Cancel / Delete /
  Edit / Duplicate / Refresh / Reconnect / Disconnect / Test →
  `Save` / `X` / `Trash2` / `Pencil` / `Copy` / `RefreshCw` /
  `RefreshCcw` / `LogOut` / `Activity`.
- Toggle buttons: Enable / Disable → `Power` / `PowerOff`.
- Sort / group / filter chips: use the matching pair (`ArrowDownAZ` /
  `ArrowDownZA`, `CalendarArrowDown` / `CalendarArrowUp`, `Group`,
  `Eye`, `Bell` / `BellOff`).

Icon-only buttons keep the label in the `title` and `aria-label` attrs
so screen readers still get the text.

Search the repo for an existing example before inventing a new pairing.
When adding a new pill, wire the icon at the same time — never in a
follow-up PR. When you see a label-only pill during an edit, add the
leading icon in the same PR.

## 20c. Brand assets (MANDATORY — never regenerate)

Both the ImpactIQ brand mark and any tenant/theme logo already exist as files in the repo. Never hand-draw or synthesize a replacement.

**Canonical locations:**
- **SVG (vector, in-app):** `src/client/public/logo-9-iq-spark-arcs.svg` — used by the sidebar (`src/client/components/ui/nav.tsx` refers to it as `/logo-9-iq-spark-arcs.svg`). Use SVG for in-browser rendering: sidebar, login, setup, any web UI that isn't email.
- **PNG (raster, emails + anywhere SVG doesn't render):** `public/impactiq-mark.png` — served at `${publicBaseUrl}/public/impactiq-mark.png`. Use PNG for outbound email templates, Slack unfurls, downloaded reports, or anywhere Outlook Windows might touch the asset (Outlook Windows only partially renders inline SVG, so PNG is mandatory there).

**Rules:**
1. Never generate a placeholder / hand-drawn PNG. If the raster asset is missing, ask the user for a PNG export of the SVG.
2. Never reference the SVG from an outbound email — always the PNG.
3. Tenant/theme logos uploaded via Admin → Themes live as data URIs on `app_themes.logo_light` / `logo_dark`. The server route `GET /public/theme-logo/:themeId/:variant.png` decodes them to raw bytes on demand — do not add file-system copies of tenant logos.
4. Anything dropped into `public/` at repo root is served publicly at `${publicBaseUrl}/public/<file>` by the Express static handler. Use this for any static image the server needs to expose (email header art, downloadable brand assets).
5. The Dockerfile production stage MUST copy `/app/public` alongside `dist` / `node_modules` / `src/client/dist`. If the /public route 404s after a deploy, that COPY line is missing.

## 20b. Version bump checklist (MANDATORY)

Every version bump — `src/client/lib/version.ts` and root
`package.json` — must also add a matching entry to
`src/shared/changelog.ts`. Also add one bullet for the release at the bottom of
`docs/history.md` (the detailed why-and-how record; CLAUDE.md itself
stays short). The in-app version chip popover reads
only that file. Skipping it leaves users on the new version staring
at last release's notes.

Format: newest first, `version` matches `APP_VERSION`, 1–4 short
highlight bullets, `date: 'yyyy-MM-dd'`.

**Every bullet names its category** *(v1.445+)*: `{ category, text }`, where category is one of
`security` (🔒 Security & Compliance: access control, auth, encryption, audit, vulnerable dependencies),
`feature` (🆕 New Features: a new page, dashboard, setting, integration or capability), `improvement`
(🔧 Improvements: a change to something that already exists, wording, layout, performance) or `fix`
(🐛 Fixes: something that was broken now works). Same four headings as CriteriaIQ's Change Log
(`src/shared/changelogCategories.ts`); What's new and the App Updates panel group by them. Pick the one
a user would look under; a security fix is `security`, not `fix`. The App Updates parser
(`services/updates/parseChangelog.ts`) still reads a plain-string bullet, as an Improvement.

---

## 21. What NOT to Do

- Do not hardcode SF field API names — always read from `sf_field_mappings` table.
  **Fixed in v1.298** — `PATCH /api/salesforce/opportunities/:id/assigned-se` (the Assigned Oppty
  SE picker's write) previously hardcoded `Assigned_SE__c` regardless of `sf_field_mappings`. See
  §9's "Assigned Oppty SE — read/write field surfacing" for the fix: a new, dedicated
  `assigned_se_write` app field, kept separate from the pre-existing `assigned_se_name` mapping
  because that one can legitimately point at a read-only relationship path like
  `Assigned_SE__r.Name`, which can never be a write target.
- Do not hardcode activity types in frontend logic — always derive from `team_activity_types`
- Do not hardcode team names or slugs in business logic
- Do not store tokens in localStorage or sessionStorage — server-side only
- Do not render leader dashboard data from draft activities — submitted only
- Do not skip i18n `t()` wrappers — every string, every time
- Do not define `dark:` without its light equivalent
- Do not write to Salesforce synchronously — async queue only
- Do not expose `outlook_event_id` to the user anywhere in the UI
- Do not write SF Event for activity types configured as Task — respect `sf_object_type`

---

*Last updated: November 2026 — v1.481.0 (`POST /api/v1/activities/log`: an App Admin's `activities:log` key lets DemoIQ log a demo as a draft for the SE by email; contract in `docs/activity-log-api.md`. Full version history is in `docs/history.md`; this footer only tracks the most recent release.)*
*Maintainer: the repository owner*
*Repo: https://github.com/egarlepp/impactiq*
