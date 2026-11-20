# Feature write-ups

> Support Tickets, Activities Disconnected from SF, Opportunity Relink, App Updates, Announcements, Backup & Restore.
> Moved out of CLAUDE.md in v1.412.1 to keep that file short. Content is unchanged; section numbers (§) refer to CLAUDE.md.

### Support Ticket attachment *(v1.337+)*

Any Activity Type (Support being the first an admin turns it on for) can attach
multiple Salesforce support tickets to an activity — optional, multi-valued,
read-only link-out. Built as a new **`ticket_picker`** kind on the existing
per-Activity-Type SF Extras mechanism (`team_activity_type_sf_extras` — see
§14's Activity Types bullet), the same opt-in pattern `related_object_picker`
already uses, rather than a hardcoded "Support" special-case.

- **Storage is ImpactIQ-only** — `activity_sf_tickets` (migration 0146), one
  row per attached ticket with a denormalized snapshot (subject, status,
  contact, description, platform, owner) taken at attach time, same
  "snapshot now, don't re-read live forever" convention as `sf_what_name`.
  `POST`/`PATCH /api/activities` accept a `tickets` array that replaces the
  full attached set on save, mirroring `productIds`. **Never part of the
  Salesforce write-back payload** — `buildSfRecord()` in `writeback.ts` never
  reads this table, the same contract as Subtypes and Marketing Event Name
  above. The ticket number is a plain link to
  `{instanceUrl}/{ticketId}` (opens in a new tab) — no SF write happens on
  attach or detach.
- **Every display field is resolved via SF Field Mappings, never typed into
  the Extra's own config** — per the admin's own request, this follows the
  Evaluation ("Project") field convention (§9), not `related_object_picker`'s
  convention of storing field names directly in the Extra. New app fields:
  `ticket_number`, `ticket_subject`, `ticket_date_opened`, `ticket_status`,
  `ticket_contact`, `ticket_description`, `ticket_platform`, `ticket_owner`,
  and `ticket_account` (the lookup field on the ticket object pointing at
  Account — used to scope the default view). All direction `read` — there's
  no write-capable app field here, so this SObject is correctly invisible to
  the Validate & Dry Run panel (§9) unless another mapping on the same object
  happens to be write-capable.
  `GET /api/salesforce/tickets/search` resolves these live per request (own
  1-hour describe cache, same "no shared cache across features" convention
  as the Evaluation block) using the calling user's own SF connection, never
  the admin one — a contributor-facing read, same as every other Salesforce
  search in the app.
  Contact/Owner are each resolved from a raw Salesforce Id to a name
  *(fixed v1.339, extended v1.340)* when the mapped field is a genuine
  lookup. `OwnerId`-shaped fields are POLYMORPHIC — a ticket's owner
  genuinely flips between a person (`User`) and a queue (`Group`) over its
  lifecycle, and describe() reports both as valid `referenceTo` targets,
  but the admin UI's auto-capture only ever stores one of the two. v1.339's
  fix (gated on `reference_to === 'User'`, reusing Project Primary
  Engineer's `resolveUserLookupNames()` helper against the local `sf_users`
  cache) therefore still showed a raw Id whenever the current owner was a
  Queue. `resolveOwnerLookupNames()` (v1.340) fixes this properly: it tries
  the local `sf_users` cache first, then falls back to a single live SOQL
  query against `Group` (which covers Queues — a Queue is stored as a
  `Group` with `Type='Queue'`) for whatever's left unresolved — and the
  gating condition widened from an exact `'User'` match to any truthy
  `reference_to`, so it fires regardless of which of the two polymorphic
  target types the admin UI happened to capture. No local Group/Queue cache
  table was added — queues are far less numerous and change far less often
  than users, so a live round-trip per distinct owner Id per request is
  cheap here, unlike doing the same for every user on every request (which
  is exactly why `sf_users` exists as a cache in the first place). A lookup
  to Contact/Account/etc. is still left as the raw Id — there's no local
  cache for those object types today.
- **The Extra's own config** (`team_activity_type_sf_extras.config`) holds
  only `sobject`, an optional display `label`, and `closedStatusValues` (a
  comma-separated list of Status values the admin picks from a live picklist
  fetched via the existing `GET /api/admin/sf/fields?object=` describe
  endpoint, once `ticket_status` is mapped) — not object/field names, which
  live in SF Field Mappings instead.
- **Default view is the connected Account's tickets, not closed** — scoped
  via `ticket_account` against the activity's own linked Account (direct
  Account link, or an Opportunity's parent Account). **Open Search is always
  available as a toggle** (a two-icon segmented control, same visual
  convention as the Attendees section's Salesforce search toggle — but
  defaulting to the Account-scoped icon, the opposite default from that
  toggle), not a mode that only appears once no Account is linked — a
  contributor can search tickets outside the connected Account at any time.
  A **Show Closed** checkbox (off by default, same convention as Salesforce
  Link's own Show Closed toggle, §7) reveals tickets whose Status is in the
  admin's configured `closedStatusValues`.
- Admin config lives on Admin → Activity Types → Salesforce Extras (a third
  "Ticket picker" option alongside Opp field / Related picker) for which
  Activity Types show it, and on Admin → SF Field Mappings for the actual
  field names — a team not yet configured either way sees no picker at all,
  same "inert until mapped" convention as Project Primary Engineer / the
  Total Bookings breakdown fields (§9).
- **Form placement (v1.338+, refined v1.339)** — renders directly between
  the Activity Type/Subtype row and the Start/End Time row (v1.338 first
  moved it out from down by the Salesforce Link section; v1.339 moved it
  one step earlier still, from just after Start/End Time to just after
  Activity Type/Subtype, so it appears the moment a type with a
  `ticket_picker` Extra configured is chosen, before the SE has even gotten
  to Start/End Time) — not down by the Salesforce Link section where the
  Opportunity-linked Extras (`opp_field_display`/`related_object_picker`)
  still live. A ticket picker only ever needs an Account (direct link, or an
  Opportunity's parent Account resolved before the SF Link field is even
  touched) — never an Opportunity itself — so it doesn't belong gated behind
  the "link an Opportunity to see this activity type's Salesforce extras"
  empty state the other two kinds show. `SfExtrasPanel` split into two
  components sharing one `useActivityTypeSfExtras()` fetch hook: the
  original `SfExtrasPanel` (unchanged behavior, Opportunity-gated) and a new
  `TicketExtrasPanel` mounted higher up the form — splitting them avoids a
  second `GET /api/activities/sf-extras/:typeId` call per type.
- **Drawer-open background refresh of already-attached tickets** *(v1.341+)*
  — the snapshot columns above are written once, at attach time, and nothing
  re-reads them afterward on their own; an admin reported Ticket Owner
  showing correctly on a fresh search result but staying stale on a ticket
  attached before the v1.340 polymorphic-owner fix. Rather than a nightly
  batch job (no other consumer needs one yet) or folding the refresh into
  the blocking initial-hydration fetch (would delay the drawer's own open
  for however long the SF round-trip takes), the fix is a **second, fully
  non-blocking fetch** fired right after the existing hydration effect
  populates `tickets` — the drawer has already rendered with the stored
  snapshot by the time it goes out. `GET /api/salesforce/tickets/refresh?
  activityId=` (`routes/salesforce.ts`) looks up the activity's already-
  attached ticket ids, resolves the team's `ticket_picker` Extra config and
  field mappings, and runs ONE batched `WHERE Id IN (...)` SOQL query (never
  one request per ticket) against the calling user's own SF connection —
  reusing the exact same describe-filtering / field-extraction / lookup-name
  helpers `GET /tickets/search` already uses (`buildTicketSelectPairs()`,
  `filterTicketSelectPairsByDescribe()`, `extractTicketFields()`,
  `resolveTicketLookupNames()`, all factored out of that route so the two
  never drift), then persists the refreshed values back onto each
  `activity_sf_tickets` row and returns them. Degrades to the unchanged
  stored snapshot at every failure point — activity not found, nothing
  attached, no `ticket_picker` Extra configured, user not SF-connected, no
  resolvable fields, or the SOQL query itself failing — same "always return
  something useful, never block on Salesforce" contract as the rest of this
  feature. Client-side, `ActivityForm.tsx` tracks a separate
  `ticketsRefreshing` boolean (never gates the drawer's render) and shows a
  small `Loader2` spinner next to the Support Tickets label while the
  background call is in flight, merging matched-by-`sfTicketId` fresh field
  values into the existing `tickets` state on response.
- **Card indicator: flush right rail** *(v1.342+)* — an approved activity with at least one
  attached ticket (`activity.ticketCount > 0`, batch-counted per activity alongside `notesCount`
  in `GET /api/activities`'s list query, same grouped-count-then-map pattern) renders a solid red,
  full-card-height rail flush against the right edge (`w-5` = 20px, `Ticket` icon centered, white
  on red, `dark:bg-red-600` for dark mode) — the right-edge counterpart to the left type-color bar
  activity cards already carry, so the two never compete for space. Draft activities don't get the
  rail (only `status === 'submitted'`, mirroring the left bar's own submitted-vs-draft distinction).
  The card gains conditional right padding (`pr-6`) when the rail is present so it doesn't sit on
  top of the checkmark/sync-status row already hugging the right edge.

### Activities Disconnected from SF *(v1.344+)*

Salesforce records an activity links to — the What (Account/Opportunity/Campaign), Who
(Contact/Lead), or Related (e.g. Evaluation/Project) — can be deleted after the activity
already links to them. Rare, but until this feature there was **no detection at all**: a
stale link just sat there silently forever, invisible to the contributor and every leader.

Three new boolean flags on `activities` — `sfWhatDeleted` / `sfWhoDeleted` /
`sfRelatedDeleted` — plus `sfDisconnectCheckedAt` (last time either check below touched the
row), set by two independent, self-healing mechanisms:

- **Nightly job** (`services/salesforce/detectDisconnectedLinks.ts`, `detect_disconnected_links`
  on Admin → Scheduling, 24h cadence matching `refresh_opp_snapshots`) — discovers every
  distinct `(linkField, objectType)` pair actually present on `activities` (What's object type
  is a fixed 3-value enum; Who and Related are free text/org-configured, so nothing is
  hardcoded), batch-checks existence against the **admin** SF connection in chunks of 200, and
  bulk-writes the flags for whatever a chunk's query actually returned. Each `(linkField,
  objectType, chunk)` call is independently try/caught (`anomalies.ts`'s "one detector's
  failure never blanks the others" convention, deliberately finer-grained than
  `won-without-poc`'s single big try/catch) — a misconfigured Related-object string on one team
  must never blank every other team's results. **A chunk whose query throws writes nothing for
  that chunk** — existing flags and `sfDisconnectCheckedAt` are left untouched, never flipped to
  `true` — matching the "absent from a failed fetch is not the same as deleted" precedent from
  Deleted Outlook Activities (§10). Self-healing both ways: a record found again (Recycle Bin
  restore, or a prior transient failure now resolved) clears its flag back to `false`.
- **Drawer live-check** (`GET /api/salesforce/activity-link-status?activityId=`,
  `routes/salesforce.ts`) — fires once, non-blocking, whenever an activity with at least one SF
  link is opened in the edit drawer (`ActivityForm.tsx`), using the viewing contributor's own SF
  connection. More current than the nightly batch for whoever is actively looking at one record
  right now. Same self-healing/never-treat-a-failure-as-deleted contract, checked per link so
  one link's failure never blocks the others. Renders a small amber banner naming which link(s)
  are broken (purely informational — nothing is locked or blocked), with a `Loader2` "Checking
  Salesforce…" state while in flight, same visual language as the v1.341.0 ticket-refresh
  spinner.

Both mechanisms share `checkSfRecordsExist()` (`services/salesforce/referenceResolver.ts`), a
new sibling to the pre-existing `resolveSfReferences()` — that function's own catch block
collapses a thrown query error into the same `null` a genuine "not found" produces, which is
fine for a display-name lookup but unsafe here (a transient SF failure would falsely flag
activities as disconnected). `checkSfRecordsExist()` deliberately lets a query exception
propagate instead; every caller catches it itself and treats a thrown error as "check failed,
leave existing state alone," never as "confirmed deleted."

**Card badge** (`ActivityCard.tsx`) — a rose `Link2Off` badge ("SF link broken") shown whenever
any of the 3 flags is true, entirely batch-driven from the nightly job's stored flags (no
per-card live check). Shown on **both draft and submitted** cards — unlike the leader
dashboard below (submitted-only per §21), surfacing the problem to the owning contributor
before they even submit is more useful than waiting. Distinct color/icon from the existing red
"Outlook only" (never-linked) and orange "Not In Outlook" (deleted Outlook meeting, kept)
badges so the three never get confused for one another.

**Dashboard** — see §13's Activity group, "Activities Disconnected from SF."

### Opportunity Relink *(v1.345+)*

A different, related problem from the one above: a Salesforce rep closes an Opportunity as
Closed Lost or Closed - Duplicate — often because the deal moved to a renewal, or was
split/merged into a different Opportunity — while the real, ongoing/won work continues under
a DIFFERENT, live Opportunity. Every ImpactIQ activity still linked to the old, now-dead
Opportunity reads as "lost" or "duplicate" even though the underlying work was won. ImpactIQ
has no lineage/renewal field anywhere in the schema or SF field mappings, so this needs a
human to notice and correct it — a **Relink** action moves the activities, and a **Closed
Lost — Needs Review** dashboard (§13, Manager group) surfaces the candidates proactively.

- **Scope: all-time, ImpactIQ-only.** Relinking moves EVERY activity ever logged in ImpactIQ
  against the old Opportunity — draft and submitted alike, no date-range narrowing — but
  never touches or cares about any Salesforce Activity ImpactIQ itself didn't create or link.
  This is deliberately a different rule from every leader-dashboard read in this file (§21:
  "never render draft data on leader dashboards") — the relink action is a bulk data
  CORRECTION, not a dashboard read, so a contributor's still-open draft pointing at a dead
  Opportunity is exactly as wrong as a submitted one and gets corrected too.
- **`POST /api/activities/relink-opportunity`** (`routes/activities.ts`), gated
  `requireRole('leader', 'admin')` — passes for Team Leader, Team Admin, and App Admin (App
  Admin short-circuits before the team-membership check), and is inherently scoped to the
  `teamId` in the request body, avoiding the "gate says yes but the query isn't scoped to the
  right team" bug class this file has flagged repeatedly (§18).
- **Live read of the target Opportunity via the admin SF connection**
  (`getAdminSfConnection()`), never the acting user's own — same "org-wide snapshot write,
  never per-clicking-user" convention as the manual "Refresh from Salesforce" button (§13),
  since this writes a durable snapshot onto potentially many activities and must not vary by
  which Leader happens to click it. Reuses the exact field set and resolution logic
  `refreshOppSnapshots.ts`'s own nightly patch uses (`CORE_SELECT`, `collectExtraSelect`,
  `resolveAppFieldPaths`/`resolveFieldPath` for Assigned SE / Primary Engineer), so a
  relinked activity's snapshot is bit-for-bit what the nightly job would have produced for
  the new Opportunity. Never trusts a client-supplied search-result payload for the write —
  a bulk write with audit-log stakes always re-reads live.
- **Local correction**: `activities.sfWhatId`/`sfWhatType`/`sfWhatName`/`sfAccountId`/
  `sfAccountName` plus the SF-derived snapshot columns (`salesStage`, `forecastCategory`,
  `oppAmount`, `sfIsClosed`, `sfIsWon`, `sfOppCloseDate`, `sfOppOwnerId`/`sfOppOwnerName`,
  `sfAssignedSeName`/`sfPrimaryEngineerName`, `sfSnapshotRefreshedAt`) are bulk-updated for
  every activity on `team_id = :teamId AND sf_what_type = 'Opportunity' AND sf_what_id =
  :fromOppId`. Also resets `sfWhatDeleted = false` / `sfDisconnectCheckedAt = now()` — the
  target Opp was just confirmed to exist by the live read, so any stale "SF link broken"
  badge (the Activities Disconnected from SF feature above) must clear immediately rather
  than wait for the next nightly `detect_disconnected_links` pass.
- **Salesforce write-back is the existing async queue — no new SF-calling code.** Confirmed
  directly in `writeback.ts`: `buildSfRecord()` unconditionally includes
  `record[whatIdField] = activity.sfWhatId`, and the same `record` is used for both the
  create path (`sfRecordId` null) and the update path (`sfRecordId` already set) — the
  operation is chosen purely by whether `sfRecordId` exists. So the relink's entire "push to
  Salesforce" step is a second UPDATE setting `sfSyncStatus = 'pending'` (plus clearing
  `sfSyncError`/`sfSyncAttempts`/`sfNextRetryAt`) on rows at the NEW `toOppId` that already
  have `sfRecordId IS NOT NULL` — the 30s write-back poller picks those up and correctly hits
  the update path against the pre-existing Event/Task, never creating a duplicate. A draft
  (or a submitted-but-never-synced row) needs no re-queue at all — `buildSfRecord()` reads
  `activity.sfWhatId` fresh the first time it ever syncs. A subsequent SF rejection flows
  through the exact same failure path every other write-back failure already takes, surfaced
  on CRM Sync Issues with no new UI.
- **`SfActivitiesModal.tsx`** gets the one Relink UI in the app (reused, not duplicated, by
  the Closed Lost — Needs Review dashboard's own row action) — a Relink button shown only
  for an Opportunity drill-in when the viewer holds leader/team_admin/admin on that team or
  is App Admin (client-side convenience gate; the real enforcement is the server route
  above), opening an inline `<SfSearch showClosed>` picker and a confirm dialog stating the
  activity count and that this also pushes to Salesforce.
- **Audit**: `activity.relink_opportunity` (`shared/auditActions.ts`, not in
  `DESTRUCTIVE_AUDIT_ACTIONS` — nothing is deleted, this is a correction, same
  classification as `sf_field_mapping.update`). `meta` is a flat summary (`teamId`,
  `fromOppId`/`fromOppName`, `toOppId`/`toOppName`, `activitiesUpdated`, `requeuedForSync`),
  not a `{before, after}` pair — `AuditMetaBody` only renders a diff table from `before`/
  `after` keys, so a flat N-row summary renders via its raw-JSON fallback, matching
  `team.create`'s own clone-route audit entry.
- **`opp_review_dismissals`** (migration 0148) backs the dashboard's Dismiss action — see
  §13.

## 14b. App Updates — self-update check *(v1.332.0+, Phase 1; v1.333.0+, Phase 2)*

Phase 1 tells App Admins whether a newer ImpactIQ version exists on a pinned
GitHub branch and what changed. Requested as a way to know about and review
available updates from inside the app before deciding to redeploy, similar in
spirit to what a PaaS deploy panel shows.

Phase 2 adds a default-admin-scheduled maintenance window: an announcement +
live countdown shown to every signed-in user ahead of a restart, and the app
restarting its own process at the scheduled instant. **This is NOT an
automatic redeploy** — see the Phase 2 section below for exactly what it does
and does not do; that distinction is the single most important thing to
understand about this feature before touching it.

**Deliberately host-independent** — the biggest constraint on the design. The
app can be deployed via Dokploy, a bare Azure VM, or a local Docker Compose
stack, and nothing in this feature may assume any of them. Concretely: no
Dokploy API calls, no CI/build-time `GIT_SHA` injection, no assumption about
how a restart would even be triggered. The "current version" the app compares
against is simply `APP_VERSION` (now `src/shared/appVersion.ts`, re-exported
from `src/client/lib/version.ts` for existing call sites — moved so the
*server* can import the identical constant, which it couldn't while it lived
under `src/client/`). The "latest version" is read by fetching
`src/shared/changelog.ts` off the pinned branch via the plain GitHub Contents
API and parsing out `CHANGELOG[0].version` — leaning on the §20b MANDATORY
convention that this array's first entry always matches `APP_VERSION` exactly
at every release. No Docker/CI changes, no new infrastructure.

**Trust boundary — tighter than every other App Admin surface, by deliberate
product decision.** Any App Admin can VIEW: cached check status (last checked,
current vs. latest version, what changed), and the configured owner/repo/pinned
branch (never the token itself). Every ACTION — saving or clearing the GitHub
PAT, and triggering a live "Check now" — is restricted to the single
`users.is_default_admin` account (`requireDefaultAdmin` in
`middleware/rbac.ts`, mirroring `requireAppAdmin`), not the whole App Admin
population. App Admin is a flag any number of accounts can hold (§5); the
default admin is the app's one designated owner-equivalent account (a genuine,
pre-existing singleton — `admin.ts`'s User Management save route already
enforces it can never be zero and demotes the previous holder atomically when
reassigned). Configuring where update checks come from, and deciding to spend
a live GitHub API call, are treated as "the owner's call," the same way this
app treats very few other things. Every save/clear is audit-logged
(`system_update.settings_save` / `.settings_clear` / `.check_now` in
`src/shared/auditActions.ts`) and gated behind a real client-side confirm
dialog (`window.confirm`, same convention as Slack/admin-SF disconnect) before
either write fires — not just a plain button click. The Phase 2 maintenance
window (below) is gated identically — scheduling/cancelling a restart is a
default-admin-only action with its own confirm dialog and its own audit
actions (`system_update.maintenance_schedule` / `.maintenance_cancel`).

**Pinned branch is `main`, fixed in code** (`PINNED_BRANCH` constant in
`services/updates/checkForUpdates.ts`), not an admin-editable field — "pinned"
means exactly that, so a compromised or careless admin can't silently repoint
update checks at an arbitrary branch or fork. It's still surfaced everywhere
the admin sees status (the Integrations card, the sidebar modal) per explicit
requirement that it be visible even though it isn't configurable.

**Storage** — `system_settings` (existing generic key-value table, no new
migration needed): `github_update_config` (owner, repo, PAT — AES-256-GCM
encrypted via the same `encryptToken`/`decryptToken` cipher as SF/MS refresh
tokens and the Slack bot token) and `github_update_status` (the cached result
of the last check: checkedAt, currentVersion, latestVersion, updateAvailable,
newEntries, error). Every read-only surface — the sidebar dot, the modal on
open, the Integrations card's status line — reads the cached row; only an
explicit "Check now" or the scheduled job performs a live GitHub call.

**Changelog parsing is a hand-written safe parser, not `eval`/`new Function`
and not a regex/line-scrape** (`services/updates/parseChangelog.ts`) — the
fetched file is untrusted text (from whatever repo/branch the default admin
configured), so it is never executed, even sandboxed. A small recursive-descent
tokenizer/parser understands just enough of the relaxed-JS-literal grammar
`ChangelogEntry[]` actually uses (object/array literals, single/double-quoted
strings with backslash escapes, comments, trailing commas) to extract
`{version, date, highlights}` rows structurally. Malformed individual entries
are silently dropped rather than failing the whole parse. Unit-tested
(`parseChangelog.test.ts`) including the exact "backslash-escaped apostrophe
inside a single-quoted string" shape this file's own entries already use, and
a "the source is never executed" regression case.

**Scheduled job** — `check_for_updates` (`services/updates/checkForUpdates.ts`,
registered like every other job via `scheduleJob()`/`writeRun()`, listed on
Admin → Scheduling with a Run Now button same as any other job), 6h tick.
Follows the "only log real work" gate (§18/Scheduling convention): not
configured is a genuine no-op and writes no `job_runs` row; once configured,
every tick is a real GitHub call and always records a run, success or failure.

**Sidebar UI** (`nav.tsx`) — an icon-only Update pill appended to the existing
Theme+Logout footer flex container, so it automatically renders to the right
of Logout when expanded and below it when collapsed with zero new responsive
logic (App Admin gated, opens `UpdateModal.tsx`); a small amber dot on the
version chip next to `v{APP_VERSION}` when a newer version is cached as
available. Both read the cached status fetched once on mount — no polling.

### Phase 2 — scheduled maintenance window + self-restart *(v1.333.0+)*

**The restart question, answered up front, because it shapes everything
below**: this feature does **not** pull code, rebuild, or redeploy anything.
What's running in the container is compiled JS baked into a Docker image at
build time — the GitHub repo being ahead of `APP_VERSION` (all Phase 1 checks)
says nothing about what's actually loaded in memory. Getting a newer version
live requires pulling source, `npm ci`, a `tsc`/Vite rebuild, and any new DB
migrations — none of which a running process can do to itself. Doing that
generically, from inside the app, across Dokploy/Azure-VM/local-Compose hosts
would mean either giving the app Docker-socket access (a real
privilege-escalation surface — a Node process with control over the host's
Docker daemon is most of the way to root on that host) or picking one
specific host's API (reintroducing exactly the assumption Phase 1 was built to
avoid). Neither was something to build without an explicit decision, so this
phase deliberately stops short of it — **see "Not built" below.**

**What Phase 2 actually is**: the default admin schedules a restart for a
specific future date/time, with an optional message. From that moment until
the scheduled time, every signed-in user sees an announcement; in the final 30
minutes it becomes a live countdown; at the scheduled instant the app exits
its own process (`process.exit(0)`), relying on the container's restart
policy (`restart: unless-stopped` in `docker-compose.yml`) to bring it back
up. **This only puts a newer version in place if the admin has already staged
a rebuilt image/container out-of-band before the scheduled time** — e.g.
`git pull && docker compose build` run ahead of time, with the actual `up -d`
cutover left to this feature instead of the admin needing to be present at
exactly the announced moment. If nothing was staged, the self-restart simply
brings the same version back up a few seconds later — a legitimate, safe
default, not a bug, but worth knowing before scheduling one expecting a
version bump to happen automatically.

**Storage** — same `system_settings` table, key `maintenance_window`
(`services/updates/maintenanceWindow.ts`): `scheduledAt`, an optional
`message`, `status` (`scheduled` | `completed` | `cancelled`), `createdBy` /
`createdByEmail`, `createdAt`, `completedAt`. Scheduling a new window always
replaces whatever was there — there is only ever one "current" window.
Cancelling deletes the row outright (nothing useful to show about a window
that never happened); completing sets `status: 'completed'` and
`completedAt`, which is what backs the post-restart confirmation banner.

**The GET is public to any signed-in user, not just admins** — registered
before `adminRouter`'s blanket admin gate, the identical pattern the v1.322.0
fiscal-year fix already established (`GET /admin/fiscal-year`,
`GET /admin/maintenance-window` right below it). The whole point is every
user sees the announcement; PUT/DELETE stay `requireDefaultAdmin`.

**`restartScheduler.ts`** — a 15s-tick job (`restart_scheduler` on Admin →
Scheduling, cadence not editable), follows the same "only log real work" gate
as every other fast-tick job: a tick with nothing due writes no `job_runs`
row. When a window is due, it re-reads and re-marks-completed inside
`markMaintenanceWindowCompleted()` (guards against a race with an admin
cancelling between the job's check and its write), audit-logs
`system_update.restart_triggered` via a new `logSystemAudit()`
(`services/audit/log.ts` — the row has no actor, since a background job has
no `Request` to pull one from), writes the job run, waits a flat 3s grace
delay (not a real graceful `server.close()` drain — a scheduled, announced
restart doesn't need one), then exits.

**`MaintenanceBanner.tsx`** — mirrors `connections-banner.tsx`'s sticky-
banner-at-the-top-of-the-shell pattern rather than inventing a new visual
language (same amber tone, same X-to-dismiss-per-session convention). Three
states: advance notice (dismissible per session, reappears next login, same
contract as the Outlook/SF reminders), the final-30-minute live countdown
(**not dismissible** — a restart with data-loss potential for anyone mid-edit
is the one case in this app worth overriding "let the user hide it"), and a
post-restart confirmation (dismissible, auto-expires 2h after `completedAt`).
Dismissal keys off `scheduledAt`/`completedAt` rather than a fixed
sessionStorage flag, so a rescheduled or newly-completed window always shows
again even if a prior one was dismissed. Polls the window every 60s; once one
exists, ticks a local clock every 1s for the countdown display — the actual
restart timing is driven server-side, this is display only, and on a fetch
failure (e.g. the exact moment the process is restarting) it keeps the last
known state rather than blanking the banner right when it matters most.

**Admin UI** — a second section within the same Admin → Integrations → App
Updates card (`GithubUpdatesForm.tsx`), below the existing GitHub PAT config,
rather than a new card — schedule/reschedule (datetime + optional message)
and cancel, both default-admin-only with their own `window.confirm` dialogs,
status visible to any App Admin viewing the card.

**Not built** — actually triggering a redeploy (pulling code, rebuilding,
swapping the image) is still not built and is not a small follow-on to this
phase; it's a genuinely separate decision (Docker-socket access vs. a
host-specific API) that needs its own explicit sign-off before any code gets
written. See Deferred/Roadmap.

---

## 14c. Announcements — team broadcast messages *(v1.349+)*

Admins/Team Admins/Leaders post a message that shows in the top-header banner (alongside
`MaintenanceBanner`/`ConnectionsBanner`) and in the notification bell until dismissed, targeted
at a team, a subteam, or one specific person.

**One target per announcement, mutually exclusive** — `announcements.targetType` is `'team'` |
`'subteam'` | `'user'`, with `subteamId`/`targetUserId` set only for the matching type (enforced
in the route, not a DB CHECK constraint — same convention `keyword_rules.action =
'mark_non_activity'` already uses for its own NULL-iff-X invariant, §11). No multi-team
"assign to teams" checkbox list like keyword/nudge rules — broadcasting to several teams means
creating the announcement more than once. Deliberately simpler than that junction-table pattern
because an announcement's audience is a one-time authoring choice, not an evolving assignment an
admin revisits.

**Leaders are restricted to a subteam they lead or a specific person — never team-wide.**
`canPostAnnouncementTarget()` (`src/server/routes/teams.ts`, exported for testability like
`buildSfRecord()`/`validateOne()`): App Admin or a `team_admin`/`admin` team-role holder may post
any target type; a plain `leader` is rejected outright for `targetType='team'`, allowed for
`'subteam'` only if they hold a `role='leader'` row in `subteam_users` for that specific
subteam, and allowed for `'user'` only if the target shares an accessible team with them
(`sharesAccessibleTeamWith()`, a local reimplementation of `admin.ts`'s private
`canManageUserAlignment()` — that helper isn't exported, so the equivalent check is duplicated
here rather than reaching into another router file for a private function). Delete follows the
same shape plus one more guardrail: a plain leader may delete only an announcement they created
themselves; team_admin/admin/App Admin may delete any announcement on their team.

**Routing pitfall — `adminRouter`'s blanket gate excludes plain Leaders entirely.** The CRUD
routes were first written under `adminRouter` (`admin.ts`), gated per-route with
`requireRole('leader', 'admin')` — which typechecks and looks correct, but `adminRouter.use(
requireAuth, requireGlobalAdmin)` runs BEFORE any per-route check, and `requireGlobalAdmin` only
admits App Admin or a `team_admin`/`admin` team-role holder (never a plain `leader`). A Leader
would 403 at the router-level gate before ever reaching the per-route check meant to allow them
in — completely defeating the "Leaders can post to their subteam/a person" requirement, the
actual reason this feature exists alongside Team Admin. Fixed by moving the whole route block to
`teamsRouter` (`routes/teams.ts`, mounted at `/api/teams`, gated only by `requireAuth`) — the
same fix already applied to Opportunity Relink (§7) for the identical reason. **Any admin
feature meant to be reachable by a plain Leader must not live under `adminRouter`** — check the
router's own blanket gate, not just the per-route `requireRole` call, before assuming a route is
reachable by the roles it names.

**Recurrence resets at the viewer's own local midnight, not a fixed UTC cutoff** — reuses
`localDayKeyFor(tz, at)` (`src/server/lib/localDate.ts`, extracted from private duplicates in
`digest.ts`/`weekly-recap.ts` when this feature needed the exact same primitive — three
independent copies of one date computation is exactly the drift this file flags repeatedly
elsewhere). The SAME viewer-local "today" backs both the `[startDate, endDate]` active-window
check and the dismiss-reset check, so an announcement's own date range and its dismiss state
never disagree about what day it is.

**`announcement_dismissals` is a single-row upsert per (user, announcement), not an
insert-many-and-filter-by-expiry table like `nudge_dismissals`.** A nudge snooze needs multiple
historical rows because each one carries its own independent `expiresAt`; here there is only
ever ONE piece of state per user per announcement — "the last local calendar day I dismissed
this" — and whether that means "hidden today only" or "hidden forever" is decided **entirely at
read time** by the announcement's own `recurringDaily` flag, never stored on the dismissal row
itself. A non-recurring announcement's dismissal suppresses it permanently; a recurring one's
dismissal suppresses it only for `dismissedLocalDate`, and it reappears once the viewer's
`todayLocalKey` advances past that. This means flipping `recurringDaily` after the fact
immediately changes behavior for every existing dismissal, with zero data migration — a
deliberate simplification over mirroring nudges' shape.

**Bell + banner dual-surface, one shared source, no new poll.** Announcements sync into the
SAME `notifications` table nudges already use, with `kind: 'announcement'` and `dedupeKey:
`announcement:${id}:${todayLocalKey}`` — reusing the exact `onConflictDoUpdate` partial-unique-
index pattern (`notifications_dedupe_idx`) `syncNudgeNotifications` already uses, so a genuinely
new viewer-local day always inserts a fresh unread row. `syncAnnouncementNotifications(userId)`
(no `teamId` param, deliberately — an announcement addressed to you should show regardless of
which team tab is currently selected) runs in `GET /api/notifications` alongside
`syncNudgeNotifications`, in its own independent try/catch so one failing sync never blanks the
other. The bell (`NotificationBell` in `notifications.tsx`) needed zero changes — it already
renders any `kind` generically via the now-exported `SEVERITY_STYLES`. The new
`AnnouncementBanner.tsx`, mounted in `PageShell` (`App.tsx`) right after `<ConnectionsBanner />`
and before `<ConnectToast />`, subscribes to the SAME shared `useNotifications()` module-level
cache/poll and filters `items.filter(n => n.kind === 'announcement')` — no second request.
Dismiss (X) is the only removal path; marking read has no suppression effect, since Dismiss
already IS the daily reset for a recurring announcement.

**A real scoping gap, found and fixed before shipping**: `notifications.teamId` is nullable, and
announcement rows deliberately never set it — but the EXISTING `GET /api/notifications` read
query and `POST /read-all` scope both filtered `WHERE team_id = :teamId` whenever a specific team
was selected in the header switcher, which would have silently hidden every announcement from
the bell/banner for any user with a specific team selected (the common case, not "All Teams").
Fixed by OR-ing `kind = 'announcement'` into both scopes. Worth remembering for any future
`notifications`-table feature that, like this one, should follow the viewer rather than the
currently-selected team tab.

No scheduled job — matches the established `evaluateNudges()`/`isMaintenanceWindowDue()`
precedent: a pure "is this within its date range, and not currently dismissed" check runs live
on every `/api/notifications` poll. A background job is only warranted when something must
proactively ACT at a moment nobody is polling (e.g. `restartScheduler.ts` killing the process) —
not the case for a display/dismiss feature.

**Stale-row cleanup, fixed same day it shipped (v1.349.1)** — reported immediately: deleting an
announcement, or editing its start date into the future, left the banner/bell entry showing
indefinitely. `syncAnnouncementNotifications()` (`routes/notifications.ts`) originally only ever
inserted/refreshed rows for CURRENTLY active announcements — it had no code path that removed a
row once the announcement backing it was gone, deactivated, or its date range no longer covered
today. The dismiss action was never responsible for that either: it only ever marks *today's*
instance handled per the design above, it was never a general-purpose "this announcement no
longer exists" cleanup. Fixed by having every sync also diff the user's existing
`kind='announcement'` rows against the currently-active id set and delete whatever no longer
resolves — self-healing on every poll (≤60s), same as nudges rely on for their own re-evaluation.
`AnnouncementsConfig.tsx` additionally calls the shared `useNotifications().refresh()` right
after a create/update/delete, so the admin making the change sees their own banner/bell update
immediately rather than waiting out the poll window. Regression-tested in
`notifications.announcementSync.test.ts` (delete / deactivate / re-date, plus a still-active
control case) — `syncAnnouncementNotifications` exported for pglite testability, same convention
as `buildSfRecord()`/`validateOne()`.

**Duplicate banner on a still-active announcement, fixed (v1.349.5)** — the v1.349.1 cleanup
above closed the "announcement is gone" case but left a second, narrower gap: an announcement
that stays active across multiple consecutive days (never dismissed) accumulated one
`notifications` row PER DAY instead of ever replacing the previous day's. Each sync mints a
per-day `dedupeKey` (`announcement:${id}:${todayLocalKey}`) so a genuinely new day always gets a
fresh unread row — that part is correct and load-bearing for the recurring-announcement design
(§14c). But v1.349.1's cleanup only ever asked "is this row's announcement id still active?" —
yesterday's row and today's row both answer yes for a still-active announcement, so both
survived, rendering as two identical banners for one announcement. Fixed by comparing against the
exact SET of `dedupeKey`s just upserted THIS sync, not just the announcement id — a row whose
`dedupeKey` isn't in that set is stale regardless of whether its announcement is still active,
which subsumes the original "deleted/deactivated" case too (a strictly simpler, single check
replacing the old id-based one). Regression-tested in `notifications.announcementSync.test.ts` by
syncing once, hand-backdating the resulting row's `dedupeKey` to simulate a previous day (same
technique `engine.test.ts` already uses to simulate day changes elsewhere), then syncing again and
asserting exactly one row survives, dated today.

**Clickable links + text wrapping (v1.349.2)** — announcement (and, since it shares the same
renderer, every other) message text is plain-text-only, no rich-text editor, so a pasted URL or
email address rendered as dead text. New `src/client/lib/linkify.tsx` (`linkifyText()`) turns any
`http(s)://` URL or email address found in a message into a real `<a>` — reused by the bell
dropdown, the bottom toast, and `AnnouncementBanner.tsx` so the three notification surfaces don't
drift on what counts as a link. Client-only, no server change: React text nodes are inherently
XSS-safe (no `dangerouslySetInnerHTML`), so this is purely a rendering upgrade, never a new
injection surface. Also fixed a real overflow bug found alongside it — a long URL has no spaces
for the browser's default text wrapping to break on, and the message `<span>`/`<p>` sat in a flex
row with no `min-w-0`, so a long link pushed the card wider instead of wrapping (the classic
"flex children default to `min-width: auto`" trap). Fixed with `min-w-0` on the flex message
child plus Tailwind's `break-words` (`overflow-wrap: break-word`) across all three surfaces.

**Custom header-banner icon + light/dark colors (v1.349.4)** — an admin can now pick a specific
icon per announcement, plus a color for it — but only the top-header banner ever renders it; the
bell dropdown and the bottom toast always show the plain severity icon regardless. Three new
nullable columns: `announcements.icon` (a lucide name, same `IconPicker`/`DynamicIcon`
convention as `flight_deck_items.icon`) and `iconColorLight`/`iconColorDark` — a genuine pair,
not one value assumed to work in both themes, since a color chosen in light mode frequently
reads poorly in dark mode and vice versa. All three null (the default) is the unchanged current
behavior: plain severity icon and color.

The color pair has to travel through `notifications` too (two mirrored nullable columns there),
not just live on `announcements` — the banner reads from the shared `useNotifications()` cache
(`GET /api/notifications`, callable by any signed-in Contributor), while the admin CRUD route
`GET /:teamId/announcements` is `requireRole('leader','admin')`-gated, so a plain Contributor
viewing the banner can never fetch an announcement row directly. `syncAnnouncementNotifications()`
threads `icon`/`iconColorLight`/`iconColorDark` onto the synced row exactly like it already does
for `message`/`severity`.

**"Header bar only" is enforced with a one-line kind carve-out**, not a second code path:
`NotificationBell`'s existing `n.icon ? <DynamicIcon/> : <sev.Icon/>` ternary (already used by
nudges) becomes `n.kind !== 'announcement' && n.icon ? ... : ...` — nudge rows are unaffected,
announcement rows always fall back to the plain severity icon in the bell. The toast never read
`n.icon` at all, so it needed no equivalent change.

**Resolving light vs. dark is done in JS against the viewer's OWN live theme, not a CSS `dark:`
class trick** — `AnnouncementBanner.tsx` calls the existing `useTheme()` hook (already used the
same way in `App.tsx`/`PageShell`) and picks `theme === 'dark' ? n.iconColorDark :
n.iconColorLight` directly into an inline `style={{color}}` on `DynamicIcon`. `useTheme()` is
already resolved to a concrete `'light' | 'dark'` by render time, so this needed no
class-duplication or CSS custom-property indirection. No custom icon → unchanged severity
icon/color. Custom icon but no color set for the CURRENT theme → still the custom icon shape,
falls back to the severity's own tint (`sev.text`) rather than an undefined default color.

**New shared `src/client/components/ui/color-picker.tsx`, extracted from `ThemingConfig.tsx`'s
previously-private `ColorField`** — swatch button + hex text input + a `react-colorful`
`HexColorPicker` popover, generalized off `ThemeColors`-specific typing to plain `value: string |
null` / `onChange: (next: string) => void` / an optional `onReset`. Chosen over a second native
`<input type="color">` (the pattern Activity Types and Flight Deck already use for their own
single, non-dark-mode-aware icon color) specifically because `ThemingConfig.tsx` had already
paid to move OFF native color inputs after one froze users' browsers via the OS-level eyedropper
regardless of debouncing (see that file's own `v1.35.2`/`v1.36` history) — reusing the safer,
already-proven picker for a brand-new light+dark pair avoids reintroducing that exact bug class.
`ThemingConfig.tsx` itself now imports and uses the shared component instead of its own copy, so
there's exactly one implementation. Preserved the original's "stable field-change callback so the
picker's own `memo()` short-circuits and only the field being dragged re-renders" performance
property across ~30 theme color fields — `ColorGrid` now builds a `useMemo`-memoized map of
per-field closures keyed off the (already-stable) `onFieldChange` reference, rather than a fresh
inline closure per field on every render, which would have silently defeated every `ColorPicker`
instance's memoization the moment any one field changed.

**Toast severity styling, a genuinely separate fix bundled into the same release** — the
bottom-of-screen `NotificationToast` had never respected severity at all: a hardcoded blue `Bell`
icon on a hardcoded blue background for every notification, announcement or otherwise. New
`TOAST_SEVERITY_STYLES` (deliberately a second map, NOT a change to the shared `SEVERITY_STYLES`
the bell dropdown and the banner's border still use — those stay blue/amber/red, untouched, since
neither was reported as wrong) — green/orange/red, each with real light/dark Tailwind classes.
Applies to every notification kind shown via the toast (nudge, sync-failure, announcement,
anything future), not just announcements, since the toast already read `top.severity` for every
kind; this just makes it mean something visually.

---

## 14d. Backup & Restore — full database export / import *(v1.375+)*

Admin → Monitoring & Audit → **Backup & Restore** (`BackupRestore.tsx`, routes in
`routes/backup.ts` mounted at `/api/admin/backup`, engine in `services/backup/backup.ts`).
App Admin only, for both export and import — a backup holds the whole database
(password hashes and encrypted tokens included) and a restore replaces it. Built to move
ImpactIQ to a new install, or keep an offline copy.

- **What's in it**: every table in the `public` schema, discovered from `pg_catalog` at
  run time (never a hardcoded list, so a table added by a future migration is included
  automatically) — themes with their data-URI logos, the login logo, `system_settings`
  (integration configs, still encrypted), history, audit log, everything. **Not in it**:
  environment variables and server secrets (`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`,
  `SESSION_SECRET`, `APP_URL`…) — each install keeps its own; and the `sessions` table
  (`EXCLUDED_TABLES`), since a restore signs everyone out by design.
- **Format**: gzip'd, line-oriented text (`IMPACTIQ-BACKUP\t1`, an `H` header line, a `T`
  line per table, an `R` line per row, an `E` end line with per-table counts). Rows come
  from `row_to_json(t)::text` and go back through `json_populate_recordset` **without
  ever being JSON.parse'd in Node**, so numerics wider than a JS double, arrays, jsonb,
  bytea and enums round-trip byte-for-byte with zero per-type code. The header carries
  `APP_VERSION`, the schema version (newest migration tag + count from `_journal.json`)
  and `encryptionKeyCheck()` — an HMAC fingerprint of `TOKEN_ENCRYPTION_KEY`
  (`services/config/crypto.ts`), never the key itself.
- **Export** streams straight to the response (`GET /export`, a plain browser navigation,
  so nothing is buffered in page memory) from one read-only `REPEATABLE READ`
  transaction — a single consistent snapshot — paging each table by `ctid` (TID range
  scan), never `OFFSET`. A mid-stream failure aborts the download rather than ending it
  cleanly, and a file without its `E` end marker is refused on import.
- **Import is two steps.** `POST /import` streams the upload (raw `application/octet-stream`,
  `BACKUP_MAX_UPLOAD_MB`, default 2048) to a temp file and runs `previewBackup()`, which
  writes nothing: it validates structure and row counts, compares the schema version
  (**must match exactly** — install the backup's version, restore, then upgrade; old data
  is never pushed through a mismatched schema), refuses a backup with zero App Admins,
  and warns when the key fingerprint differs or the importing admin's own email isn't in
  the backup (it lists the backup's App Admin accounts to sign in with). Preview issues
  are codes (`admin.backup.issue.<code>`), not prose. `POST /import/:token/apply` requires
  the typed word `RESTORE`, re-checks the schema, and restores.
- **Restore runs in ONE transaction**: snapshot the preserved settings → drop every FK in
  `public` → `TRUNCATE` every table → batch-insert (500 rows / ~4 MB, `OVERRIDING SYSTEM
  VALUE`, generated columns skipped) → **re-create every FK**, which re-validates every
  row → reset any serial/identity sequences → put the preserved settings back → write the
  `system_backup.restore` audit row. Any failure rolls the whole thing back and the install
  is untouched (`system_backup.restore_failed` is then logged outside the transaction).
  Dropping/re-adding FKs needs table **ownership**, not superuser — the app's own DB user
  already owns its tables because it runs the migrations. Verified on real Postgres 16 with
  a non-superuser owner as well as pglite.
- **Preserved, not restored** (`PRESERVED_SETTINGS_KEYS`): `app_public_base_url` (the new
  install's own URL), `maintenance_window` (a stale scheduled restart from the source
  would otherwise restart the new install immediately), `github_update_status` (cache).
- **The audit row for a restore is written inside the restore transaction, last** — any
  audit row written before the `TRUNCATE` would be wiped by it. `actor_user_id` is kept
  only if that user also exists in the restored data (else NULL, email kept).
- **After a restore** the server reloads its boot-time caches from the restored data
  (`reloadIntegrationConfigs()`, `loadAuthPolicy()`, `loadRateLimitSettings()`), and the
  client sends the admin to sign-in. `loadIntegrationConfigs()` now decrypts per row, so
  one secret that won't decrypt under a different key no longer drops every other
  integration back to env vars.
- **Encrypted values and a different key**: SF/Outlook tokens, MFA secrets and integration
  secrets come over still encrypted. They only work if the new install's
  `TOKEN_ENCRYPTION_KEY` equals the source's — otherwise users reconnect and admins
  re-enter integration secrets. Preview warns when the fingerprints differ.
- Pending uploads are in-process memory (token → temp file), per admin, 30-minute TTL,
  matching the app's existing single-instance assumptions (in-memory rate limiter).
