# ImpactIQ — Product Requirements Document (PRD)
**Version:** 2.4
**Owner:** the repository owner
**Repo:** https://github.com/egarlepp/impactiq
**Status:** Shipped and in production — app version v1.349.6
**Last Updated:** September 2026

> **How to read this document.** Everything in §1–§4 is **built and shipped**
> unless explicitly marked otherwise. This PRD was originally written as a
> pre-development spec for the MVP; it has since been reconciled against what
> actually exists. Where the delivered behaviour differs from the original
> intent, the original intent is kept and annotated rather than deleted — the
> reasoning behind a change is usually more useful than the change itself.
>
> `CLAUDE.md` is the authoritative technical/architectural reference and is
> more detailed than this document. `README.md` is the feature-level overview.
> Per-release notes live in `src/shared/changelog.ts`.

---

## Executive Summary

ImpactIQ is a self-hosted tool that enables contributors (Sales Engineers, Channel,
Sales, and other teams) to capture their technical validation activities, link them to
CRM Opportunities and Accounts (Salesforce, or HubSpot Deals and Companies), and provide Team Leaders with honest capacity
planning visibility.

**The core problem:** Team capacity is invisible. Leaders make resourcing decisions without
knowing where time is actually going. Contributors have no easy way to log work that
doesn't fit neatly into a CRM task.

**The solution:** A contributor-first activity logging tool anchored to the Outlook calendar,
with the CRM (Salesforce or HubSpot) as the system of record for deal context, leadership dashboards derived
from what contributors actually log, and a multi-team architecture so different teams
(SE, Channel, Sales) each have their own activity types, rulesets, and SF configuration.

**Critical cultural note:** ImpactIQ is a *capacity planning tool*, not a performance
management tool. This must be explicitly visible in the UI. Adoption depends on
psychological safety.

---

## 1. User Roles

| Role | Description | Key Capabilities |
|---|---|---|
| **Contributor** | Individual logging their work | Log activities, link to SF, view team's finalized activities |
| **Team Leader** | Manager viewing capacity | Read-only dashboards, scoped to team or global |
| **Team Admin** | Configures their own team | Leader access plus team-scoped config (activity types, keyword/nudge rules, capacity + cost groups, role assignment within the team) |
| **App Admin** | Configures the system | Full access to all teams, global config, and monitoring pages |

Roles are team-scoped. A user can have different roles on different teams — e.g.
Team Admin on Sales Engineering and Contributor on Channel. App Admin is a global
flag (`users.is_app_admin`) independent of team membership.

**Delivered vs. original spec:** the original three roles became four. Team Admin
was split out of App Admin because per-team configuration (rules, capacity
targets) needs to be delegable without also handing over teams, theming, global
SF mappings, and tenant monitoring.

---

## 2. Multi-Team Model

Teams are the top-level configuration namespace in ImpactIQ.

| Property | Description |
|---|---|
| Name | Display name (e.g., "Sales Engineering", "Channel", "Sales") |
| Activity Types | Which of the 10 types are active for this team |
| SF Object per Type | Whether each activity type writes to SF Event or SF Task |
| SF Field Mappings | Salesforce field API name mappings for this team |
| Keyword Rules | AI suggestion keyword rules for this team |
| Nudge Rules | Nudge trigger rules for this team |
| Capacity Groups | Capacity configuration groups for this team |

**Default seed:** A "Sales Engineering" team is created on first install with full
default configuration so the app is functional immediately.

---

## 3. Activity Model

### 3.1 Activity Types (10 — Default for Sales Engineering Team)

| Type | Default SF Object | SF Link |
|---|---|---|
| Demo | Event | Recommended |
| Discovery | Event | Recommended |
| Enablement | Event | Optional |
| Eval Work | Event | Required |
| Executive Briefing | Event | Recommended |
| HealthCheck | Event | Required |
| Marketing | Event | Optional |
| Meeting | Event | Optional |
| RFx Work | Event | Required |
| Support | Event | Recommended |

**Note (corrected):** the original spec said Meeting was missing from the SF
Event Type picklist. That is **no longer true** — Meeting is present, and is in fact
the most-used Event Type in the reference org. The fallback-value mechanism still exists
for any type genuinely absent from a given org's picklist.

**Admin can:** activate/deactivate types per team, change SF object type (Event vs
Task) per type, set colour + icon, set a Salesforce picklist-value override (so
several ImpactIQ types can roll up to one SF value), set a typical duration, attach
Salesforce Extras, mark one type as the **Default suggestion**, and **create new
types**.

**Delivered vs. original spec:** "Cannot add new types in v1" was lifted — admins
create types freely. The seeded 10 are a starting point, not a fixed set.

### 3.2 Existing SF Event Type Picklist Values
```
Marketing | Discovery | Demo | Enablement | RFx Work |
HealthCheck | Executive Briefing | Support | Eval Work
```

### 3.3 Activity Record Fields

| Field | Type | Notes |
|---|---|---|
| Title | Text | Pre-filled from Outlook subject if linked |
| Activity Type | Team-configured enum | Suggested by AI engine; contributor confirms |
| Status | Draft / Submitted | Leaders see Submitted only |
| Start Date/Time | DateTime | Pre-filled from Outlook event |
| End Date/Time | DateTime | Pre-filled from Outlook event |
| Effort Hours | Decimal | Pre-filled from event duration; always editable |
| Notes | Text | Optional free-form |
| Outlook Event ID | Hidden | Internal dedup only; never shown to contributor |
| Salesforce Link | Opp or Account | Selected via SF search |
| SF Sync Status | Pending / Synced / Failed | System-managed |

**Added since the original spec:** description body, location mode (remote/onsite),
meeting owner, attendees, products (many-to-many), ACV, incidental costs
(transportation / lodging / food + currency), Salesforce Who (Contact/Lead) and
Related (Evaluation-style child object) links, Opportunity snapshot fields
(stage / forecast category / amount / close date, refreshed nightly), Outlook
write-back status, `submitted_at` (the approval date), and the deleted-meeting
review flags. See `drizzle/schema.ts` for the authoritative list.

### 3.4 Activity States

```
[Draft] → [Submitted] → [Archived after 2 years]
            ↑
        Contributor can edit within 90 days of creation
        Read-only after 90 days
```

---

## 4. Feature Requirements

### 4.1 Contributor Weekly View

**Description:** The primary screen — activity list on the left, Outlook calendar on the right.

- FR-VIEW-01: Left panel shows contributor's activities for the current week, grouped by day
- FR-VIEW-02: Right panel shows Outlook calendar (week view), collapsible by the contributor
- FR-VIEW-03: Calendar panel is expanded by default
- FR-VIEW-04: AI suggestion badge visible on each activity card (suggested vs confirmed)
- FR-VIEW-05: Nudge notifications appear as non-blocking banners above the activity list
- FR-VIEW-06: Week navigation (prev/next week) available on both panels
- FR-VIEW-07: "Log Activity" CTA always visible regardless of calendar panel state

### 4.2 Outlook Calendar Panel

- FR-CAL-01: Display week and day views via Microsoft Graph API
- FR-CAL-02: Show events with title, time, duration
- FR-CAL-03: Click any event → open pre-populated activity log form (slide-in panel or modal)
- FR-CAL-04: Events already linked to a logged activity show a visual "logged" badge
- FR-CAL-05: Clicking an already-logged event → warning, prevent duplicate logging
- FR-CAL-06: Calendar respects contributor's timezone
- FR-CAL-07: Manual activity creation available independent of any calendar event

### 4.3 Activity Logging

- FR-ACT-01: Contributor can create activity from calendar event (pre-populated) or manually
- FR-ACT-02: Activity type suggestion shown prominently; contributor must confirm or change
- FR-ACT-03: Effort hours pre-filled from event duration; always editable
- FR-ACT-04: SF search inline within activity form — not a separate screen
- FR-ACT-05: Activities saved as Draft until contributor explicitly submits
- FR-ACT-06: Contributor can edit their own activities freely within 90 days of creation
- FR-ACT-07: Activities become read-only after 90 days
- FR-ACT-08: Submitted activities trigger async SF write-back (Event or Task per type config)
- FR-ACT-09: SF sync status visible to contributor (pending / synced / failed)
- FR-ACT-10: Failed SF sync surfaces retry option to contributor
- FR-ACT-11: Persistent UI note: "ImpactIQ is a capacity planning tool. Activity data is not used in performance reviews."

### 4.4 Salesforce Integration

- FR-SF-01: Per-user Salesforce OAuth 2.0; refresh token stored server-side encrypted
- FR-SF-02: Silent re-auth from refresh token; full re-prompt only on expiry/revocation
- FR-SF-03: Activity form search shows two tabs: "My Opportunities/Accounts" and "Open Search"
- FR-SF-04: "My" filter checks the Opportunity owner plus every field the team maps as SE Filter (OR logic); no field names are hardcoded (v1.474)
- FR-SF-05: Search returns Opportunities and Accounts in separate tabs; contributor selects one
- FR-SF-06: Selection type (Opportunity vs Account) determines `WhatId` on SF write-back
- FR-SF-07: Write-back uses activity type's configured SF object (Event or Task)
- FR-SF-08: Write-back is asynchronous — contributor never blocked
- FR-SF-09: Admin can update SF field mappings without a code deploy
- FR-SF-10: Admin can configure SF object type per activity type (Event or Task)

> **Since v1.383–v1.407, the CRM is a choice, not a given.** Each install runs one CRM:
> Salesforce (default), HubSpot, or none, chosen in the Setup wizard or Admin → Integrations →
> CRM and locked once activities link to CRM records. On HubSpot the requirements above map to:
> one portal-wide service key / private app token instead of per-user OAuth (users matched to
> HubSpot owners by email); Deals and Companies instead of Opportunities and Accounts; a
> meeting or task instead of an Event or Task; and the "My" filter using the matched owner or a
> mapped SE property. All CRM work goes through a provider interface so another CRM can be
> added the same way. See `docs/crm.md`.

### 4.5 Activity Type Suggestion (Hybrid AI Engine)

**Layer 1 — Keyword Matching (Primary, team-scoped):**
- FR-AI-01: Admin configures keyword rules per team (keywords → activity type, match field, priority)
- FR-AI-02: Matched against Outlook event subject and/or body
- FR-AI-03: High-confidence match → auto-suggest with confidence badge
- FR-AI-04: No match or low confidence → Layer 2

**Layer 1.5 — The contributor's own Non-Activity keywords (added v1.243):**
- FR-AI-09: User enters comma-separated subject text in My Settings → Data & Templates
- FR-AI-10: Matching meetings are auto-marked Non-Activity in **that user's** ImpactIQ only
- FR-AI-11: Runs after the team rules (a team rule assigning a real type still wins) and before the AI classifier — an explicit user instruction outranks a guess
- FR-AI-12: Subject only; meeting bodies are deliberately not searched

**Layer 2 — Azure OpenAI (Fallback):**
- FR-AI-05: GPT-4o on the configured Azure OpenAI resource classifies event into team's active activity types
- FR-AI-06: Returns suggestion + confidence score
- FR-AI-07: Always a suggestion — contributor makes final call
- FR-AI-08: Never auto-selects; contributor must confirm

**Layer 3 — Fallback when nothing matches (added v1.240, revised v1.241):**
- FR-AI-13: Admin may mark one activity type per team as the **Default suggestion**
- FR-AI-14: If a default is set, unmatched meetings suggest it (low confidence, labelled DEFAULT)
- FR-AI-15: If no default is set, the meeting is left **untyped** and shown as **No Match** — still visible, still approvable, with the contributor picking a type on approval
- FR-AI-16: The engine must never fall back to a positional guess (e.g. "first active type"). A confident wrong type is worse than an honest blank

**Non-Activity exclusion (added v1.240):**
- FR-AI-17: A team keyword rule may target **Non-Activity** instead of an activity type, auto-excluding matching meetings for the whole team
- FR-AI-18: Non-Activity marking is per-user and per-event, reversible via "Mark as Activity", and never creates or deletes activity rows
- FR-AI-19: "No Match" and "Non-Activity" are distinct states and must not be conflated — the first means nobody has decided, the second means someone decided it isn't work

### 4.6 Nudge Engine (Team-Scoped)

- FR-NUD-01: Non-blocking notification banners in contributor's weekly view
- FR-NUD-02: Default nudge rules seeded for Sales Engineering team
- FR-NUD-03: Admin can create, edit, disable nudge rules per team
- FR-NUD-04: Contributor can dismiss individual nudges
- FR-NUD-05: Dismissed nudges do not reappear for same trigger within 7 days

**Delivered vs. original spec:** FR-NUD-05's "7 days" was replaced with a richer, three-action
dismiss model rather than one fixed window:
- FR-NUD-06 (v1.292+): **Mark read** mutes a rule until next UTC midnight, **Snooze** mutes it
  for an admin-chosen 1/7/30 days, and **Close out** (bell notification only, deliberately not
  available on the quick-glance weekly-view card or toast) mutes it permanently until cleared.
- FR-NUD-07 (v1.324+): each nudge rule has an admin-editable **Name**, since a team can have
  several rules sharing the same trigger type — the rule list, Nudge History, and audit logs all
  identify a rule by this name rather than its raw trigger type.
- FR-NUD-08: an optional per-rule **cooldown** (minimum hours between deliveries to the same
  user) and an optional **AND/OR condition** layered on top of the base trigger.
- FR-NUD-09: an optional per-rule **leader roll-up threshold** — instead of nudging members
  individually, aggregate to a single nudge for their leader once N members have been nudged.
- FR-NUD-10 (v1.324+): **Nudge History** (Admin → Monitoring & Audit) is team-scoped like every
  other Nudge Rules screen (App Admins can still view **All Teams** tenant-wide), with a
  History/Dismissals tab switcher and a 4-KPI row (Top Nudge, Top User, Most Snoozed Nudge, Top
  Snoozing User).
- Delivery channels: in-app banner, Slack (per-team Incoming Webhook), and email — all per-rule
  toggles. Microsoft Teams delivery is designed but not built (§7).

### 4.7 Leader Dashboards (Team-Scoped)

All data from submitted activities only.

**Delivered:** 30+ dashboards across 10 groups, not the 3 originally specified. The
three below shipped as specified; the rest were added as the capacity conversation
matured. Current set — Capacity (Team Heatmap, This-Week Capacity, Capacity Trend),
Activity (Breakdown, Mix, Plan vs Actual, Activity SubType Breakdown, **Activities
Disconnected from SF** — v1.344), Accounts (Account/Opportunity Burn, Concentration,
Most Expensive), Health (Logging Compliance, Logging Lag, Week-over-Week Delta),
Products (Products Breakdown), Revenue (Opportunity ROI, Cost per ACV), Manager
(Team-of-Teams Rollup, Sales Team Breakdown, User Leaderboard, Team Activity Deep-Dive,
Won w/o POC, **Closed Lost — Needs Review** — v1.345), Infrastructure
(Project-Specific Costing), Coverage (Attach Rate), History (pre-ImpactIQ Salesforce
activity, estimates only).

A collapsible **"What changed"** anomaly panel (v1.220) sits above every tab,
comparing the last completed week against a fixed 8-week baseline. It is
deliberately independent of the dashboard date filter — "normal" is a property of
the team, not of the selected range — and is capped at 6 findings with volume
floors on every detector, because a panel that lights up every week becomes
wallpaper within a month.

**Dashboard 1 — Team Heatmap:**
- FR-DASH-01: Week × contributor grid, effort hours per cell, color-coded vs capacity target
- FR-DASH-02: Clickable cells drill into that contributor's activities for that week
- FR-DASH-03: Date range selector (default: last 8 weeks)

**Dashboard 2 — Activity Type Breakdown:**
- FR-DASH-04: Per-contributor effort hours by activity type
- FR-DASH-05: Bar / pie chart toggle
- FR-DASH-06: Team aggregate + individual drill-down
- FR-DASH-07: Date range filter (default: last 4 weeks)

**Dashboard 3 — Account/Opportunity Burn:**
- FR-DASH-08: Ranked by total effort hours
- FR-DASH-09: Filterable by date range, activity type, contributor
- FR-DASH-10: Visual indicator for disproportionate time concentration

### 4.8 Admin Configuration

All admin screens are team-scoped. Admin selects active team at top of admin area.

**Team Management:**
- FR-ADM-01: Create/edit teams (name, description)
- FR-ADM-02: Activate/deactivate teams

**Activity Type Config:**
- FR-ADM-03: Activate/deactivate activity types per team
- FR-ADM-04: Set SF object type (Event or Task) per activity type per team
- FR-ADM-05: Reorder activity types (affects sort order in dropdowns)

**SF Field Mappings:**
- FR-ADM-06: View and edit app field → SF API field mappings per team
- FR-ADM-07: Changes effective immediately, no deploy required

**SF Picklist Config:**
- FR-ADM-08: View SF Event and Task Type picklist values (fetched live from SF)
- FR-ADM-09: Toggle which values appear in ImpactIQ per team
- FR-ADM-10: Configure fallback Type value for activity types not in SF picklist (e.g., Meeting)

**Keyword Rules:**
- FR-ADM-11: Create/edit/delete keyword rules per team
- FR-ADM-12: Test rule against sample subject/body before saving

**Nudge Rules:**
- FR-ADM-13: Create/edit/disable nudge rules per team
- FR-ADM-14: Preview nudge message with sample tokens before saving

**Capacity Groups:**
- FR-ADM-15: Create/edit groups per team (name, target hours, method, region, role type)
- FR-ADM-16: Assign contributors to groups; one group per contributor
- FR-ADM-17: Supported methods: Fixed Hours, Self-Declared, Exception-Adjusted, **Calendar-Derived** (v1.225 — target auto-computed from the group's members' own trailing 8-week real meeting load, falling back to the group target when history is too thin)

**Note on Exception-Adjusted:** as implemented this is currently identical to
Self-Declared. The documented distinction (flat hours minus flagged exceptions)
has never been built. Kept as a separate method so existing group configuration
doesn't need migrating when it is.

**Calendar-Derived carries a trust-boundary caveat** that must stay visible in the
product, not just in docs: reading a calendar to pre-fill an activity is a
contributor-initiated, single-event action; reading it to compute someone's
capacity target is an ongoing, admin-configured read feeding a number a leader
sees. It is therefore gated per capacity group by an admin, never a per-contributor
opt-in. It also measures **meeting load, not availability** — an empty calendar is
not free time.

**User Management:**
- FR-ADM-18: View all users, roles, team membership, capacity group
- FR-ADM-19: Assign/change roles per team
- FR-ADM-20: Set Leader visibility scope (team-only or global) per leader

---

## 5. Non-Functional Requirements

### 5.1 Authentication & Security
- NFR-SEC-01: Okta OIDC primary auth, MFA at Okta layer
- NFR-SEC-02: All SF and M365 tokens server-side, AES-256 encrypted
- NFR-SEC-03: RBAC enforced server-side on every API endpoint
- NFR-SEC-04: No tokens in localStorage, sessionStorage, or frontend state
- NFR-SEC-05: All endpoints require valid Okta JWT

**Delivered vs. original spec:** password auth (TOTP MFA + backup codes) and Azure/Entra SSO
were added alongside Okta (§7). This grew the security surface, and two dedicated passes have
hardened it since:
- NFR-SEC-06 (v1.323+): password-only accounts can't reuse one of their last 5 passwords and
  must reset every 90 days, via the same `mustChangePassword` gate first-login already uses.
  Entirely exempt for any account with Okta/Azure SSO available. `users.auth_method` supports
  four mutually-exclusive choices: password-only, Okta-only, Azure-only, or "All Login Options."
- NFR-SEC-07 (v1.288–v1.289): a full read-only audit against this PRD's §5.1/§1 RBAC model
  found and fixed five cross-team/cross-tenant data-scoping gaps (the MCP server had zero
  team/user scoping; any Contributor could self-issue the API key that reached it; three routes
  trusted a client-supplied `teamId` with no membership check) plus five lower-severity findings
  (no per-account brute-force ceiling, unescaped email token substitution, a theme-logo MIME gap,
  a stack-trace disclosure, unaudited SF Field Mapping changes).
  **Recurring lesson, reinforced by name since:**
  a route's own gate (which roles get in) and its query's actual scoping (what data comes back)
  are two separate things that both need verifying on any new endpoint touching cross-team data.
- NFR-SEC-08 (v1.327+): dedicated per-route/per-router rate limiters on the OIDC callbacks
  (unauthenticated by necessity) and on the Salesforce and History routers, on top of the
  app-wide session limiter every other route already shared.
- NFR-SEC-09: two GitHub Code Scanning (`js/incomplete-sanitization`) findings — a SOQL
  string-literal escape that handled quotes but not backslashes, found in the ticket-search route
  (v1.342.1) and again in Opportunity Relink's live-record read (v1.349.6) — were both fixed by
  wiring the missed call site up to the existing shared `safeSoqlLiteral()` helper rather than a
  one-off patch, consistent with NFR-SEC-07's own recurring-lesson framing: a fix that isn't
  reused as the one blessed pattern reappears elsewhere in the codebase.

### 5.2 Data Retention
- NFR-RET-01: Active records for 2 years
- NFR-RET-02: Soft-archived after 2 years; retained indefinitely
- NFR-RET-03: Archival management UI is Phase 2

### 5.3 Internationalization
- NFR-I18N-01: All strings via `react-i18next` `t()` — no exceptions
- NFR-I18N-02: **Seven** languages: en, de, fr, es, ja, pt, **it**
- NFR-I18N-03: All seven locale files are maintained in lockstep. NFR-I18N-03 as originally written ("others fall back to English") turned out to be a trap: `t(key, 'English default')` resolves to the *default argument*, not to the `en` locale, so a missing key ships English text to non-English users silently rather than falling back visibly. Every PR adding or renaming a user-facing string must update all seven files
- NFR-I18N-04 (v1.312–v1.326): a second, distinct defect class was found and closed for every
  locale — a key can exist (passing `scripts/check-i18n-parity.py`'s key-parity check) while its
  *value* still holds literal, untranslated English text, invisible to a key-existence diff. A
  full audit plus a per-locale translation pass (de v1.313, fr v1.314, es v1.315, ja v1.316, pt
  v1.325, it v1.326) closed roughly 1,000 such keys across the six non-English locales. All seven
  locales now hold real translations everywhere a key exists, not just key parity — this is a
  standing quality bar, not a one-time cleanup, and the same defect class should be checked for
  on any future locale addition.

### 5.4 Theming
- NFR-THEME-01: Full light and dark mode
- NFR-THEME-02: Default: OS `prefers-color-scheme`
- NFR-THEME-03: Preference persisted to DB

### 5.5 Performance
- NFR-PERF-01: Activity form load < 1s (excluding SF search)
- NFR-PERF-02: SF search < 3s
- NFR-PERF-03: Leader dashboards < 3s for teams up to 50 contributors
- NFR-PERF-04: SF write-back async, never blocks contributor

### 5.6 Deployment
- NFR-DEPLOY-01: Docker image deployable to Dokploy or Azure VM
- NFR-DEPLOY-02: Containerized Postgres — no external DB dependency
- NFR-DEPLOY-03: All secrets via environment variables
- NFR-DEPLOY-04 *(v1.332–v1.333, not originally specified)*: **App Updates** — a read-only check
  against a pinned GitHub branch tells App Admins whether a newer version exists, and the default
  admin can schedule (or immediately fire) a self-restart via `process.exit(0)`, relying on the
  container's own restart policy to bring it back up. Deliberately does **not** pull code, rebuild,
  or swap the running image — it only puts a newer version live if an admin already staged a
  rebuilt image out-of-band, by design, to stay host-independent (no Docker-socket access, no
  Dokploy-specific API). Automating the build-and-deploy step itself is designed but not built —
  see `docs/deploy-agent-plan.md`

---

## 6. Open Questions

| # | Question | Status |
|---|---|---|
| OQ-02 | Okta app registration | **Resolved** — configured; see `docs/okta-setup.md` |
| OQ-03 | Azure app registration for MS Graph | **Resolved** — delegated + optional app-only; see `docs/outlook-app-only.md` |
| OQ-04 | Salesforce Connected App setup | **Resolved** — per-user OAuth plus an admin connection for org metadata |
| OQ-08 | Support a CRM other than Salesforce | **Resolved** — HubSpot ships as an install-wide alternative (v1.383–v1.407) behind a `CrmProvider` interface; see `docs/crm.md` |
| OQ-05 | Exact SF field API names for the 4 SE fields | **Resolved, and generalised** — field names are no longer hardcoded anywhere. All SF field resolution goes through the admin-editable `sf_field_mappings` table |
| OQ-06 | Meeting missing from SF Event Type picklist | **Void** — the premise was wrong. Meeting is present and is the most-used Event Type in the org |
| OQ-07 | Azure OpenAI GPT-4o deployment active? | **Resolved** — active and in use as the Layer 2 classifier |

---

## 7. Scope Changes Since v1

**Shipped despite being out of scope for v1:**

| Item | Shipped in |
|---|---|
| Write-back audit log | Sync History / CRM Sync monitoring |
| Calendar-derived capacity method | v1.225 |
| Nudge delivery via Slack (+ email) | per-rule delivery toggles |
| Bulk activity import | CSV import, personal + team-wide |

**Immediate Roadmap: Fixes and Features - In Scope once tokens available: September 2026**

- Nudge delivery via Microsoft Teams (Slack + email only today) — designed but not built; the
  recommended approach mirrors the existing per-team Slack Incoming Webhook pattern 1:1, blocked
  on confirming which webhook payload format this org's Teams tenant actually supports (classic
  `MessageCard` vs. the newer Workflows/Adaptive-Card format) before writing code

**Shipped since the last roadmap pass** (were listed here as pending, now delivered):
- Show last activity in the nudge note — the `{days_since_activity}` rich token
- Snooze / close-out from the weekly-view nudge cards — a three-action dismiss model (Mark read
  / Snooze 1-7-30 days / Close out permanently, bell-only) across every nudge surface
- Subactivity shown in the Weekly layout when approved — delivered as **Subtypes**: admin-defined
  free-text labels per activity type, selectable on the Log Activity form and visible on approved
  activity cards, with their own dashboard rollup (Activity SubType Breakdown, Subtype filter
  chips across several other dashboards)

**Future Roadmap - Still out of Scope:**

- Archival management UI (records past 2-year retention)
- CriteriaIQ-TVW integration
- Mobile-optimized views
- CloudLAB compute + travel spend in cost calculations (banner already shown on the affected dashboards)
- MCP write tools (`mcp:write`) — read-only today; gated on audit-log coverage for activity mutations
- **SE performance reporting — explicitly never.** This is the one item on this list that is a permanent product commitment rather than a backlog decision. See the cultural note in the Executive Summary; the User Leaderboard and per-user cost dashboards exist for capacity and coverage decisions, and the History dashboard deliberately omits a per-owner leaderboard because ranking people on *estimated* hours invites exactly this reading

**Major additions not contemplated in the original PRD:**

- Notes on activities (with AI organize + Salesforce push) and a My Notes workspace
- Products, activity templates, cost groups, holiday calendars, subteams, themes
- Historical Salesforce Event import (~48k pre-ImpactIQ Events) with a read-only History dashboard and `/my-history`
- Read-only MCP server for LLM agents (`POST /api/mcp`)
- App Health monitoring, background-job scheduling admin, anomaly callouts
- Password auth + TOTP MFA alongside Okta, and Azure SSO — since expanded (v1.323) with a
  password reuse/90-day-expiry policy, and Azure/Entra SSO as a fourth, genuinely
  mutually-exclusive Sign-in Method choice
- Deleted-meeting review queue for approved activities (v1.242)
- Activity type Subtypes (v1.255–v1.256), with their own dashboard rollup
- A dedicated security hardening pass (v1.288–v1.289) — see §5.1 — closing five cross-team data
  leaks plus five lower-severity findings, none of which were anticipated in the original spec
- Full i18n translation-quality closure (v1.312–v1.326) — see §5.3
- Support Ticket attachment (v1.337+) — a `ticket_picker` Salesforce Extras kind lets an admin turn
  on multi-ticket attachment for any Activity Type; ImpactIQ-only storage with a read-only link-out,
  never part of the Salesforce write-back
- Activities Disconnected from SF (v1.344+) — a nightly job plus a live drawer-open check detects
  when an activity's linked Salesforce What/Who/Related record has been deleted, surfaced as a card
  badge and a new Activity-group dashboard
- Opportunity Relink + Closed Lost — Needs Review (v1.345+) — when a rep closes an Opportunity
  Lost/Duplicate while the real work continues under a different, live Opportunity, a leader/admin
  can bulk-move every ImpactIQ activity (draft and submitted, all-time) to the new Opportunity and
  re-queue its Salesforce write-back, surfaced proactively by a new Manager-group dashboard
- App Updates, Phases 1–2 (v1.332–v1.333+) — a read-only self-update check against a pinned GitHub
  branch, plus an admin-scheduled maintenance-window countdown and self-restart (`process.exit(0)`,
  relying on the container's restart policy). Deliberately host-independent and explicitly **not**
  an auto-redeploy — see §5.6 and `docs/deploy-agent-plan.md` for the deferred Phase 3
- Themes architecture finalized (v1.347+) — the earlier separate "org default palette" singleton
  was retired and promoted into a real, assignable `app_themes` row; the app now always has exactly
  one Active theme, enforced server-side rather than by convention
- Announcements (v1.349+) — team broadcast messages targeted at a team, a subteam, or one person,
  surfaced in the header banner and notification bell with an optional recurrence and a custom
  per-announcement icon/color, sharing the existing `notifications` table and poll rather than a
  new delivery channel
- Single-button SSO login (v1.346+) and per-user Salesforce/Outlook connection status + admin
  Verify probe on User Management (v1.348+)
- HubSpot as an install-wide alternative CRM (v1.383–v1.407) — search, previews, meeting/task
  write-back, snapshot refresh, notes, tickets, Projects, link health and merges, Relink, Attach
  Rate, historical import and MCP tools, with every CRM-facing screen and string following the
  chosen CRM and a provider layer ready for further CRMs
- Multi-provider AI Assistant (v1.392+) — Anthropic, Azure OpenAI, OpenAI, Bedrock, Foundry,
  Gemini or xAI, with a monthly budget and per-feature routing
- Projects (POC|POV) source: CRM object, CriteriaIQ, or Off (v1.385–v1.388)

---

## 8. Success Metrics (90 Days Post-Launch)

| Metric | Target |
|---|---|
| Contributor adoption | ≥ 70% log at least 1 activity/week |
| Activity SF link rate | ≥ 80% of submitted activities have a SF link |
| SF sync success rate | ≥ 95% sync without error |
| Leader dashboard usage | ≥ 2x/week per leader |
| Edit rate | < 20% of activities edited post-submission |

**Instrumentation note:** most of these are now directly observable in-product —
adoption and edit rate from the Logging Compliance / Logging Lag dashboards, SF
link rate from the unlinked-activity anomaly detector, and sync success rate from
Admin → Monitoring → CRM Sync.

---

*ImpactIQ — Built for contributors, by contributors. Capacity visibility without the surveillance.*
