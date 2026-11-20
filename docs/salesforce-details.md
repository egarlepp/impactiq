# Salesforce integration details

> Field mapping validation & dry run, inline record preview, Assigned SE, Historical import, Project field prepend, notes push.
> Moved out of CLAUDE.md in v1.412.1 to keep that file short. Content is unchanged; section numbers (§) refer to CLAUDE.md.

### Field Mapping Validation & Dry Run *(v1.219+)*

`POST /api/admin/teams/:teamId/sf-field-mappings/validate` — App Admin, read-only in every
sense (no SF writes, no DB writes). Surfaced as a **Validate & dry run** panel above the
mappings table.

Exists because a bad mapping row never complains at save time, and most mapping mistakes
don't error at sync time either — they fail *silently*. `direction: 'read'` on `title`
produces an Event with a blank Subject. A missing `sf_what_id` mapping produces an Event
linked to nothing, which quietly defeats the whole integration. Neither shows up in Sync
Issues, because neither is a failure as far as Salesforce is concerned.

- **Static layer** (no Salesforce needed) — duplicate `appField` (only the first active row
  wins in `resolveSfField`, so the rest are dead config that looks live), duplicate target
  field, missing required app fields, `read` / refresh-only flags on a field the writeback
  needs, and `appField` values the code never reads.
- **Describe layer** — field exists on this org's object, is createable and updateable, its
  SF type can hold what we send, a `constantValue` fits the field length and is a valid
  picklist member, and every active activity type resolves to a Type value that's actually
  in the picklist. Uses the **admin** connection: org-level metadata inspection on an Admin
  page is exactly what it's for.
- **Dry run** — the real `buildSfRecord()` from `writeback.ts`, run against the team's most
  recent submitted activity, so the admin sees the exact payload the sync would send. It
  reuses the worker's own function on purpose; a second implementation would drift and start
  reassuring admins about a payload that never gets sent.
- **Always 200.** A Salesforce failure degrades to static-only with `describeOk: false` and
  an on-screen "static checks only" pill. A page whose job is telling admins what's broken
  must not go blank when the integration is the broken thing.
- **Scope** *(widened v1.296, again v1.338)* — three tiers, by object. **Event/Task** (from
  `Array.from(new Set(activeTypes.map(t => t.sfObjectType)))` — whatever the team's *active
  activity types* actually write to) get the full treatment: static + describe + dry-run
  payload preview via `buildSfRecord()`. **Any other object with at least one active
  `write`/`read_write` mapping** — Opportunity (the ACV secondary write-back, see below) and
  Evaluations__c (`PATCH /evaluations/:relatedId`, the SF Project field prepend-update route)
  are the two that exist today — gets its own section too, but **static + describe checks
  only**: `buildSfRecord()` has no concept of an Opportunity or Evaluations__c payload shape,
  so the dry-run preview is replaced with an explicit `dry_run_unavailable` note rather than
  silently showing nothing. **Any other object with at least one active mapping of ANY
  direction, on an object not already covered by the two tiers above** (v1.338) — e.g. the
  Support Ticket attachment's `ticket_*` fields (§7) on Case/a custom ticket object, which are
  all `direction: 'read'` and so never qualified for the write-capable tier above — gets the
  same static + describe treatment too (never a dry-run preview, same as tier two). Before
  this, a team that finished mapping a brand-new object made up entirely of read-only fields
  saw it simply never appear on the page at all, with no error or indication anything was
  skipped. This is a genuinely new, previously-unreachable class of object, not a fix for
  Assigned SE / Primary Engineer / the Total Bookings breakdown fields — those live on
  Opportunity, which already qualified for tier two via its own write-capable mappings (`acv`,
  `assigned_se_write`), so `validateOne()` was already iterating every active mapping on that
  object, read-only ones included, well before this pass. Before v1.296, ANY object outside
  Event/Task got zero coverage, including the real write mappings above.
- **False positives on inert and non-`buildSfRecord()` app fields fixed (v1.300)** — the
  describe-layer correctness checks (`not_createable`/`not_updateable`/`type_mismatch`) used to
  run against EVERY active write/read_write mapping regardless of whether anything actually
  sends that field to Salesforce. Two real bugs from that: (1) a mapping whose `appField` isn't
  one `buildSfRecord()` reads (already correctly flagged as `unknown_app_field`, "isn't an app
  field the sync reads") could ALSO get a `not_createable` **error** ("Salesforce will reject the
  record") if describe() happened to report the target field non-createable (e.g. a formula
  field) — a scary, technically-true-but-practically-meaningless finding, since that field is
  never actually included in the outbound payload either way. (2) `eval_engineer_notes` /
  `eval_next_steps` (the SF Project field prepend-update, §7) and `assigned_se_write` (§9) DO have
  a real write path — `fieldPrepend.ts` and the Assigned SE picker respectively — just not through
  `buildSfRecord()`, so they were *also* misfiled as `unknown_app_field`/"has no effect" even
  though they're actively used. New `OTHER_WRITE_APP_FIELDS` map recognizes these (plus `acv`,
  the Opportunity ACV secondary write-back) as real write targets with their own describe checks
  (e.g. `eval_engineer_notes` must resolve to a `textarea`/`string` field, matching
  `fieldPrepend.ts`'s actual restriction) — excluded from `unknown_app_field` only while their
  `direction` is actually `write`/`read_write` (a read-only row on one of these app fields is
  still genuinely inert and still gets flagged). Also fixed: `combobox` (the real SF type of the
  standard Event/Task Subject field) was missing from the `string`-kind compatible-types list,
  so every team's default `title` → `Subject` mapping showed a false `type_mismatch` error — a
  combobox is a picklist that also accepts free text, so a string value is always valid. And the
  required-field check (`missing_required_app_field` etc.) used to run for Task even when zero
  active activity types write to Task at all (Task only appears in scope because of an unrelated
  active write mapping there, e.g. a `_constant` row) — now gated on `typesHere.length > 0`, so
  an object nothing actually routes to doesn't get 4 "missing required field" errors for fields
  it will never receive.
- **Sample record** *(v1.338+)* — `GET /api/admin/teams/:teamId/sf-field-mappings/sample?sobject=`,
  a per-object "show me one real record" button rendered under each object's section,
  deliberately separate from Run Check itself so this live SOQL query only ever fires when an
  admin explicitly clicks it (Run Check never gets slower). Answers what the dry-run payload
  preview can't for anything but Event/Task: what does this actually look like coming back from
  Salesforce, field by field — most useful for exactly the object class the dry-run preview
  can't build a payload for at all (Opportunity, Evaluations__c, and any read-only-mapped
  object like the Ticket picker's Case/ticket object), but available for every object. No
  `WHERE`/`ORDER BY` — literally any one record via `SELECT Id, <mapped fields> FROM <sobject>
  LIMIT 1` on the admin connection (same org-level-read convention as the describe layer),
  resolved through the shared `resolveFieldPath()` helper (`refreshOppSnapshots.ts`) so a
  relationship-path mapping (`Owner.Name`) reads its nested value correctly instead of coming
  back blank. Requested directly off the Ticket picker's launch: an admin who's just finished
  mapping 9 fields for a brand-new object wants to see real resolved values, not just "no
  problems found."

Hovering (or keyboard-focusing) the Opportunity / Account name on an activity card opens a
popover with that record's current CRM state — stage, forecast, value, close date, owner,
Assigned SE for an Opp; owner, industry, type, location, website for an Account.

- **Endpoint** — `GET /api/salesforce/preview/:type/:id`, `type ∈ Opportunity | Account`.
  Always 200. Uses the requesting user's OWN SF connection (`getSfConnection`), never the
  admin connection — it's a contributor-facing read.
- **Two layers.** The local snapshot on `activities` (form-captured, kept fresh by
  `refresh_opp_snapshots`) is the floor, so a contributor who has never connected Salesforce
  still gets a useful preview. A live read layers over it *field by field* — wholesale
  replacement would blank `Total_Acv__c` / `Assigned_SE__r` on an org that hasn't mapped them.
  The popover footer always states which source it's showing.
- **Field list comes from `sf_field_mappings`**, via the same `collectExtraSelect()` the
  nightly refresh uses (§21 — never hardcode SF API names). Resolved list is cached per
  sobject for an hour; without that, every hover costs a `describe()` plus a mappings read.
- **Hover, not click.** The card's SF links already open the SF Activities modal on click,
  and that behavior is unchanged — on touch, where there's no hover, nothing is lost.
- **Assigned SE / Primary Engineer field-shape resilience** *(v1.279, v1.282)* — a team's
  `assigned_se_name`/`primary_engineer_name` mapping can point at either a flat text/picklist
  field (`Assigned_SE__c`, literal name string) or a Salesforce User-lookup relationship path
  (`Assigned_SE__r.Name`) — the resolver (`resolveAppFieldPaths`/`resolveFieldPath` in
  `refreshOppSnapshots.ts`, shared by the live preview and the nightly refresh) handles
  whichever shape is actually configured, and additionally falls back to the canonical flat
  field names `Assigned_SE__c`/`Primary_Engineer__c` when the configured mapping resolves to
  nothing — a resilience net, not a substitute for a correct mapping.
- **Assigned Oppty SE — read/write field surfacing** *(v1.297)* — the activity edit drawer's
  Assigned SE picker (`AssignedSePicker` in `ActivityForm.tsx`, backed by
  `GET`/`PATCH /api/salesforce/opportunities/:id/assigned-se` and
  `GET /api/salesforce/picklists/opportunity/assigned-se`) is a THIRD, separate code path from
  the two above — it never used `assigned_se_name`/`resolveAppFieldPaths()` at all. Its read
  hardcoded a 3-candidate SOQL fallback chain (`Assigned_SE__c`, `Primary_Engineer__c`,
  `Specialist_Engineer__c`) and its write unconditionally hardcoded `Assigned_SE__c` — so an
  admin who remapped `assigned_se_name` saw no effect on this picker either way, read or write.
  Fixed with a new, dedicated `assigned_se_write` app field (sfObject `Opportunity`,
  Admin → SF Field Mappings) rather than reusing `assigned_se_name` — that mapping can
  legitimately point at a read-only relationship path like `Assigned_SE__r.Name` (fine for the
  Inline Preview and nightly refresh, which only ever read it), which can never be a write
  target. `resolveAssignedSeWriteField(teamId)` in `routes/salesforce.ts` resolves the team's
  active `assigned_se_write` mapping (direction `write`/`read_write`). *(v1.474+)* There is no
  fallback field any more: unmapped means the picker is hidden (`meta.configured = false`, PATCH
  409 `errors.salesforce.assigned_se_not_configured`); migration 0186 mapped `Assigned_SE__c` for
  installs already on Salesforce. The value read falls through to the team's `opp_se_filter`
  fields (non-multi-select, present on the org) when the write field is empty. All three endpoints (`GET`/`PATCH` value, `GET` picklist values) now
  resolve and use the SAME field, so the picker's dropdown, its displayed current value, and
  what actually gets written are finally guaranteed to agree — previously the picklist endpoint
  in particular always described `Assigned_SE__c` regardless of what the value endpoints read,
  which would have shown the wrong org's picklist entirely once a custom write target existed.
  If the resolved field isn't a Picklist (e.g. a plain Text field), the picker falls back to a
  free-text "Use "&lt;value&gt;"" commit action instead of an empty, dead-end dropdown. Because
  `assigned_se_write` carries sfObject `Opportunity` with a write-capable direction, it's picked
  up automatically by the widened §9 Validate & Dry Run panel (v1.296) with no further code
  changes — it lands in the same "other write objects" Opportunity section as the `acv` mapping.
  Client calls now pass `teamId` (previously omitted entirely on this endpoint family, so there
  was no way for the server to know which team's mapping to consult even in principle).
  **`sf_field_mappings` has the identical `team_id`-column vs. `sf_field_mapping_teams`-junction
  split** as §11's nudge/keyword rule bug — caught while writing `resolveAssignedSeWriteField()`,
  whose first draft filtered on the base column directly and would have shipped the same class of
  bug into brand-new code. `writeback.ts`'s `buildSfRecord()` and `mappingValidation.ts` already
  correctly resolve via the junction (so this was never live for the actual SF write pipeline or
  Validate & Dry Run), but the "duplicate team" clone route had the same gap here as it did for
  Nudge/Keyword Rules — fixed the same pass (§18 v1.298).
- **"Not in ImpactIQ" red flag** *(v1.277+)* — `assignedSeMatched`/`primaryEngineerMatched` on
  the preview payload are `true`/`false`/`null` (null = nothing to check). Matched by NAME
  against `users.display_name`, not Salesforce User Id — a deliberate, cheap stand-in for a
  small team roster; see `isImpactIqUserName()` in `preview.ts` for the tradeoff writeup. Same
  red treatment is used on the Assigned SE picker on the activity edit/create drawer (v1.279)
  and in the Attach Rate dashboard's SE Credit / Rep Coverage tables (§13).
- **Project (Evaluation) preview** *(v1.222+, Primary Engineer v1.285–v1.286)* — a third
  preview type alongside Opportunity/Account, for the child object an activity links to via
  `sf_related_id` (org's own API name, e.g. `Evaluations__c` — never hardcoded, per §21).
  Shows Type/Status/Stage/Start/End plus, since v1.285, **Primary Engineer**, via a new
  `eval_primary_engineer` app field under Admin → SF Field Mappings. `Primary_Engineer__c` on
  Evaluations__c is a genuine Salesforce `Lookup(User)` (unlike Opportunity's Assigned SE,
  which is a picklist string) — its raw SOQL value is a User Id, not a name. Rather than a new
  admin checkbox to declare that, the resolver reuses `sf_field_mappings.reference_to`, which
  `SfFieldMappings.tsx` already auto-populates from Salesforce `describe()` metadata whenever a
  mapped field turns out to be a lookup (previously just a UI hint). Any eval field whose
  mapping has `reference_to = 'User'` is resolved against the **local** `sf_users` cache
  (`resolveUserLookupNames()` in `resolveLookupNames.ts`) rather than a second live SF
  round-trip — generalizes to any future User-lookup eval field with no further code changes.
  A lookup to Contact/Account/etc. is left as the raw Id; there's no local cache for those
  object types today.
- **The Evaluation↔Opportunity relationship is child→parent, not the reverse** *(clarified
  v1.304)* — `Evaluations__c` (the "Project" object) carries the lookup — a field on
  Evaluations__c (commonly `Opportunity__c`) that points AT the Opportunity, the same shape as
  any other child-to-parent Salesforce relationship (one Opportunity can have many Evaluations
  over time). This is what the working, correctly-functioning **related-object picker**
  (`GET /opportunities/:id/related`, config `sobject`/`parentField`/`labelField`, §14's Activity
  Types Extras) actually queries: `Evaluations__c WHERE Opportunity__c = :oppId`. It's also what
  actually sets `activities.sf_related_id` — at the moment a contributor picks a Project on the
  activity form, not from any nightly refresh.
  The seeded `evaluation_lookup` mapping (§14, migration 0087) is a DIFFERENT, older mechanism
  built on the opposite assumption — a forward field ON Opportunity holding a single current
  Evaluation Id — feeding `refresh_opp_snapshots`' `COALESCE(v.sf_related_id, a.sf_related_id)`
  patch (§12/refreshOppSnapshots.ts), meant to keep `sf_related_id` in sync if the SF-side link
  changes *after* the activity was created. That assumption doesn't hold for a standard
  child-to-parent org shape: there is no such forward field to map it to, which is exactly why
  Validate & Dry Run reports `'Evaluation__c' doesn't exist on this object` for a team modeled
  this way — not a misconfiguration an admin can correct by picking a different field name. The
  `COALESCE` means this was always harmless to the working picker-set value (it can only
  overwrite when it resolves something non-null), so a team on this org shape should simply
  deactivate the `evaluation_lookup` mapping rather than hunt for a field that isn't there. A
  real "stay in sync with later SF-side re-linking" fix for this org shape would need a
  fundamentally different query (re-deriving from `Evaluations__c` by the linked Opportunity,
  with a tie-break rule for which Evaluation is now "current") — not built, since it's a design
  decision rather than a mechanical fix.
- **Total Bookings business breakdown on the activity form** *(v1.293+)* — the Opportunity
  Info panel's gray Sales Stage/Forecast/Close Date strip (moved above the `$ Total Business`
  block so it sits directly under the Salesforce Link picker it describes, not below the money
  fields) has a chevron that expands into 4 numbers in a 2-column layout: **New Business**
  ACV/TCV (left column) and **Renewals** ACV/TCV (right column), each with a hover tooltip
  spelling out what it means (e.g. "Total Bookings New License ACV: License/1st Year" — these
  abbreviations aren't self-explanatory on their own). Four new **read/refresh-only** app
  fields — `opp_new_business_acv`, `opp_new_business_tcv`, `opp_renewal_acv`,
  `opp_renewal_tcv` — under Admin → SF Field Mappings; inert until an admin maps them to this
  org's real field API names (same "genuinely optional, no fallback field" convention as
  `eval_engineer_notes`/`eval_primary_engineer`). Live-read only, no persisted snapshot column:
  expanding the panel calls the **same** `GET /api/salesforce/preview/Opportunity/:id` endpoint
  the hover popover uses, so "refresh on open" costs no new endpoint — an admin who marks a
  mapping `refreshOnlyForReports` gets it picked up automatically via `collectExtraSelect()`,
  the same mechanism every other refresh-only Opportunity field already uses. The left ACV
  field on that panel stays editable (no behavior change) but now carries a "Total ACV (SF)"
  label above it *(v1.294: "(SF)" added, box restyled dashed/gray to fully match, and the
  displayed value now comma-formats on blur — a plain `type="number"` input can't render
  thousands separators while still accepting free entry, so the field swaps to `type="text"`
  with a formatted display when not focused and back to a real number input on focus)*,
  matching the read-only "Opp Amount (SF)" box beside it.

### Historical Activity Import *(v1.214+)*

Salesforce Events that predate ImpactIQ are imported into dedicated tables and surfaced
read-only. They are **never** mixed into `activities`.

- **Scope** — Events whose `What.Type` is `Opportunity`, `Account`, or `Evaluations__c`,
  over a 3-year lookback. In the reference org about a third of trailing-3-year Events
  qualified; the rest were scheduling-tool artifacts, Cases, and unlinked events.
- **Tables** — `sf_historical_events` (PK = SF Event Id), `sf_historical_opportunities`,
  `sf_historical_accounts`, `sf_historical_type_map`, `sf_historical_backfill_state`,
  `sf_historical_import_runs`. Migration 0111.
- **Why not `activities`** — `activities.user_id` / `team_id` / `activity_type_id` are all
  NOT NULL, and historical rows legitimately have none (departed employees, unmapped SF
  Types). Keeping them separate also means their hours can't reach a cost query.
- **Hours are estimates.** `estimated_hours` is derived from SF scheduled meeting length,
  capped for all-day events at an admin-configurable number of hours (default 8; Salesforce
  reports all-day events as 1440 minutes). Changing the cap flags estimates stale; the recompute
  rides on the existing relink pass. It is excluded from every cost, capacity, and
  utilization figure, and is always rendered via `<EstimatedHours>` as `~1.5h` in amber.
  There is no cost column and no FK to `activities` — that absence is deliberate.
- **Excluding machine-generated Events** *(v1.215+)* — `sf_historical_exclusions` holds two
  admin-managed lists, by SF `CreatedById` and by `OwnerId`. Applied in the SOQL WHERE clause
  (capped at 250 ids per kind) with an in-process backstop, so excluded rows are never fetched.
  Nothing is seeded (v1.474+): automation users differ per org. In the reference org a
  sales-engagement tool (Outreach) created about a third of the target Events and most of
  those typed `Meeting`. These are undetectable heuristically: such an integration user has `UserType = Standard`
  and a System Administrator profile, as do ZoomInfo, GONG, and Marketo. Adding a rule reports
  how many imported rows it matches; purging is a separate confirmed call guarded by an
  `expectedCount` so a concurrent backfill can't change what gets deleted.
- **Backfill** — admin-triggered and resumable. Walks backwards in 90-day slices, advancing
  the cursor only after each slice commits; replay is idempotent on the Event Id. Supports
  `?dryRun=true` for a single no-write slice to check match rates first.
- **Refresh** — only Opportunities that haven't closed. `frozen_at` is set once when
  `IsClosed` is first observed and never cleared; the nightly job filters on it.
- **Relink** — `POST /api/admin/historical-import/relink` re-resolves user / team / type
  links from local tables with no SF calls, so a bad mapping is fixable in minutes rather
  than by re-importing.
- **Linkage** — Event `OwnerId` → `users.sf_user_id` (15- and 18-char forms both indexed),
  falling back to email via `sf_users`. Unmatched owners are still stored. Team comes from
  the matched user's *current* membership, so attribution is present-tense, not
  point-in-time. Type resolution refuses to guess on ambiguity and leaves NULL.

### SF Project field prepend-update *(v1.254+)*

For two Salesforce Project fields — Engineer Notes and Situation/Next Steps — the
activity edit drawer supports a "post a dated update, keep history" write mode
instead of the field-mapping default of overwrite-on-sync: every submission is
**prepended** above existing field content with the acting user's initials and
today's date (`MM/DD/YY` computed server-side from the user's own timezone via
`Intl.DateTimeFormat`, never derived from the browser, to avoid a UTC/local
boundary bug at day edges), so nothing already on the record is ever overwritten.
`services/salesforce/fieldPrepend.ts` describes the target field on demand
(1-hour TTL cache, same convention as the other per-route describe caches in
`admin.ts`/`salesforce.ts` — no shared cache) and only allows the prepend onto
Salesforce `textarea` (Long Text/Rich Text Area) or `string` fields that are
`updateable`; anything else (picklist, number, reference, non-updateable) is
rejected client-visibly rather than attempted. The activity form shows a live
character-capacity preview against the field's real describe()-reported length
and blocks submission before it would overflow. Map `eval_engineer_notes` /
`eval_next_steps` to your org's real SF API names in Admin → SF Field Mappings —
the feature is inert until mapped. Engineer Notes is also reachable via a
checkbox next to the Notes tab draft (`NotesDrawer.tsx` and the activity drawer's
Notes tab, kept visible on edit as well as create — a v1.254.1 fix, since it had
only rendered on create originally, but a Project link is usually added or
confirmed during an edit).

### Push to Salesforce Notes from the activity drawer *(v1.307+)*

My Notes has long had a **Push to Salesforce** button that publishes a note as a
Salesforce `ContentNote` linked to the note's Opportunity or (direct-linked-only)
Account — `POST /api/notes/:id/push` → `enqueuePush()` →
`services/salesforce/notesPush.ts`'s async worker (create `ContentNote`, link via
`ContentDocumentLink`, retried on failure, audited to CRM Sync History). v1.307
surfaces that same button as two checkboxes — **Post: Opp Notes** / **Post: Acct
Notes** — directly on the activity drawer, right below **Also post this to
Engineer Notes on the linked Project** (§9 above), so a single note submission can
check all three simultaneously. Both live in `NotesDrawer.tsx`'s shared
`NotesPanel` (the edit-mode Notes tab and the standalone drawer) and in
`ActivityForm.tsx`'s create-mode inline Notes textarea — the latter already
creates a real `activity_notes` row on every save with non-empty notes text
(a pre-existing behavior, not new; see the "Notes are also a first-class feature"
comment in `ActivityForm.tsx`), so the checkboxes there push that same row via the
identical `POST /api/notes/:id/push` call, not a second implementation.

**Acct Notes rolls up through a linked Opportunity**, unlike My Notes' own Push
modal (which only offers "The linked Account (**direct**)" — an Opportunity-linked
note has no Account push option there today). The activity drawer's checkbox uses
`activities.sfAccountId`/`sfAccountName` — the Opportunity's parent Account,
already snapshotted onto the activity at save time (§9 Inline Record Preview,
v1.97.0) — so "Post: Acct Notes" is useful for the common case (most activities
link to an Opportunity, not an Account directly) rather than only the minority
that link an Account directly. This is a deliberate scope difference from My
Notes' existing modal, not a bug — My Notes wasn't changed.

Both checkboxes are secondary, non-blocking writes with the same contract as the
Engineer Notes checkbox beside them: the note itself is already saved before
either push fires, a push failure surfaces inline without undoing the note, and a
successful push unchecks the box so re-saving unrelated edits doesn't re-push
identical text. Each target creates its own separate `ContentNote` (checking both
boxes pushes two distinct SF notes, one per record) — `enqueuePush()`'s existing
dedupe (same note + same target) still applies, so re-checking a box after a
successful push is a no-op rather than a duplicate.

**Layout (v1.308.1)**: both checkboxes render on one row (not stacked) with a
hover tooltip on each spelling out exactly what it posts and to which record —
two near-identically-labeled checkboxes stacked vertically read as one
confusing group without that.
