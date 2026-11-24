# ImpactIQ release history

> Every shipped release, oldest first, with the reasoning behind each change. New entries go at the bottom.
> Moved out of CLAUDE.md in v1.412.1 to keep that file short. Content is unchanged; section numbers (§) refer to CLAUDE.md.

## Shipped

- Full activity CRUD, weekly view, Outlook calendar integration
- 4-role RBAC (Contributor / Team Leader / Team Admin / App Admin) with per-team scope
- Salesforce OAuth per user + admin, field mapping admin, async write-back queue + retry
- Multi-team architecture with subteams
- 13+ leader dashboards including Team-of-Teams Rollup, Most Expensive, User Leaderboard
- SF Opp snapshot refresh (nightly + manual), Sales Stage / Forecast Category filters, Lead → Account cache
- Nudge engine with Slack + Email delivery
- Bulk activity import
- Audit Log, Sync History, Nudge History, Login History
- Scheduling admin page with per-job error-notification opt-in
- Products, Themes, Slack per-team, Holiday calendars, Cost Groups, Activity Templates
- Password auth alongside Okta OIDC, TOTP MFA, password reset
- 7-locale i18n (en, de, fr, es, ja, pt, it)
- **MCP server (read-only, v1.145)** — Streamable-HTTP endpoint at `POST /api/mcp` for LLM agents (Claude Desktop, Claude Code, Cursor, n8n MCP Client Tool, Cowork). Scoped `mcp:read` API keys, rate limiting, `mcp_tool_calls` audit, Admin → Integrations → MCP Server kill switch (MCP activity KPIs + log now live on that same page). Full docs: `docs/mcp.md`
- **App Health + observability/performance (v1.146)** — Admin → Monitoring → App Health page (DB size, per-table row/size/scan stats with missing-index flags, slowest queries via pg_stat_statements, connection + uptime/memory). DB client hardening (pool cap, statement_timeout, optional query logger), slow-request logging, indexes on `activities` + `team_members(user_id)` (migration 0109), retention culls for audit_events / job_runs / attach_rate_history + optional activities soft-archive, dashboard "All time" window cap, in-process FX-rate cache. Collapsible admin submenu categories (Monitoring & Audit expanded by default)
- **Historical Salesforce activity import (v1.214)** — admin-triggered resumable backfill of pre-ImpactIQ Events (~48k rows over 3 years) into `sf_historical_*` tables, linked to users / Opportunities / Accounts. Surfaced in three read-only places: a Historical Salesforce Activity section on the Account/Opportunity drill-in, a personal `/my-history` page, and a History leader dashboard. Hours are estimates from SF meeting length and are excluded from all cost and capacity math. Nightly refresh of open Opportunities only (`frozen_at` freezes closed ones), plus an SF-free relink pass
- **Calendar-derived capacity (v1.225)** — see §12.1 for the full writeup. Graph fetch now carries `showAs`/`isCancelled`/`responseStatus`, closing the gap where declined/cancelled/Free events counted as real meeting time. A corrected "Meeting Load" figure (admin-gated per capacity group) is additive on leader dashboards; a 4th `calendar_derived` capacity method auto-computes a group's target from members' own trailing 8-week meeting load. Explicitly a trust-boundary shift, not just a new number — see §12.1's caveats

- **Suggestion honesty pass (v1.240–v1.241)** — `team_activity_types.is_default_suggestion` makes the "nothing matched" fallback admin-configurable instead of an accident of row order (§11); `keyword_rules.action = mark_non_activity` lets a team rule auto-exclude meetings (§7); and an unmatched meeting now renders a white **No Match** pill and stays approvable rather than being auto-hidden as a Non-Activity
- **Attendee awareness (v1.240–v1.241)** — the contributor's own Required/Optional status from the Graph invite is shown on suggested cards and in the Log Activity drawer's Meeting responses summary, plus an icon-only All / Optional / Required filter on the day list. Organizer-owned meetings resolve as Required (Graph omits the organizer from `attendees`)
- **Tentative RSVP hatch (v1.241–v1.242)** — a subtle diagonal pattern (`.stripe-tentative`) on activity cards, suggested cards, and calendar blocks, driven by the live `responseStatus` so it tracks an RSVP change instead of freezing at approval. Sets `background-image` only, so the per-type colour and the approval bar survive underneath
- **Deleted approved activities (v1.242)** — review queue for approved work whose Outlook meeting was deleted, with Keep / Delete (the product's only hard delete) — see §10
- **Per-user Non-Activity keywords (v1.243)** — `users.non_activity_keywords`, Layer 1.5 of the classification chain (§11)
- **ImpactIQ Outlook category on approval (v1.244)** — closed the gap where only ImpactIQ-authored events got categorized, never meetings someone else organized — see §10
- **Team Activity Deep-Dive + Manager-group hardening (v1.245)** — a new single-team Manager dashboard (§13) plus two fixes surfaced while building it: (1) `resolveTeamScope()` checked only `isAppAdmin`, so a Team Leader granted the global `canSeeAllTeams` flag (§5) had full cross-team visibility on Admin screens but not on Team-of-Teams Rollup, Most Expensive, or User Leaderboard — those three also used a bare `requireAuth` gate, so any signed-in Contributor could call them directly for real cross-team data regardless of the tab being hidden client-side; switched to `requireAnyLeaderOrAdmin`. (2) The Subteam / Team member / Products / Stage / Forecast / ACV Range filter chips rendered on Team-of-Teams Rollup, Sales Team Breakdown, and User Leaderboard but had no effect on their output — wired through on both client and server, matching the convention ProjectCosting/Attach Rate already used
- **Activity Type Guide page + Subtypes (v1.246–v1.256)** — see §7. A new sidebar page documenting when to use each activity type, plus admin-configurable free-text Subtypes selectable on the Log Activity form and Activity Templates when a team turns them on. Includes a Team Activity Deep-Dive Total Hours column, and dashboard/UI i18n gap fixes (Product Breakdown, Logging Compliance heatmap, Plan vs Actual tooltips) along the way
- **Flight Deck login onboarding checklist (v1.249–v1.252)** — see §14a. Team-configurable checklist in a post-login welcome modal
- **SF Project field prepend-update + consolidated Notes tab (v1.254)** — see §9. Dated, history-preserving updates to Engineer Notes / Situation-Next Steps on linked Evaluation records; a Notes tab added to the activity drawer consolidating what was a separate inline Notes field
- **CodeQL security hardening (v1.256.1)** — Okta/Azure PKCE verifier + OIDC nonce cookie now AES-256-GCM encrypted (§4); a tainted-format-string `console.error` in the SF write-back worker fixed by passing the activity id as a separate argument instead of interpolating it into the format string
- **"Why Meeting?" capture + Activity Health (v1.257–v1.258)** — see §7/§14. Optional free-text field on the Log Activity form when the type is Meeting, triaged on a new Admin → Monitoring → Activity Health page (Ignore / Will Watch / Addressed)
- **CRM Sync consolidation continued (v1.259–v1.261)** — see §14. History now captures every SF write (note pushes, Engineer Notes prepend, Assigned SE writes, Opportunity/Evaluation edits), not just activity writeback, with a Source column; Issues gets a Resolve action (reopens if it fails again), an Open/Resolved/All filter, and an immediate header/badge update on resolve. Also fixed a note-push race condition ("ContentDocument lookup failed" right after a successful create) and broadened the Engineer Notes checkbox to any activity with a linked Project, not just the type literally named "Eval Work"
- **Private Meetings (v1.262–v1.262.1)** — see §7. Outlook `sensitivity = Private/Confidential` renders as "Private meeting" with a lock icon everywhere (display substitution, not a Non-Activity mark), with a My Settings toggle (on by default) to auto-exclude them from the day list entirely
- **Scheduling calendar polish + per-user defaults (v1.263–v1.264)** — private meetings get a lock icon on the Scheduling grid and never reveal their subject to anyone but their owner (not even a leader); tentative meetings get the same striped hatch as Activities cards; the Subteams filter defaults to the viewer's own subteam(s) with an expand-to-member picker shared with the Dashboard's Subteam filter; new My Settings default Team/Subteam pickers
- **Dashboard filter-consistency audit (v1.265, v1.272, v1.274)** — see §13. Multiple passes found dashboards whose filter chips rendered live but were silently unread server-side (Subteam/Team-member across most leader dashboards; Sales Stage/Forecast on Account/Opportunity Burn + Concentration; Products + Team-member/Subteam on Opportunity ROI, Cost per ACV, Most Expensive, and Attach Rate). All fixed; treat "chip renders" and "chip is wired to the query" as two separate things to verify on any new dashboard filter
- **Subtype rollout across dashboards + two new dashboards (v1.266–v1.272)** — see §7/§13. Subtype filter chips, expand chevrons, and colored group-header icons spread from the Log Activity form to Activity Type Breakdown, Activity Mix, Team Activity Deep-Dive, and a new standalone **Activity SubType Breakdown** dashboard (Activity group). New **Won w/o POC** dashboard (Manager group) — Closed-Won Opps with logged activity but no linked Evaluation, via a live SF read. Account Concentration renamed **Account / Opportunity Concentration** and reworked to roll Opportunity/converted-Lead activity up into its parent Account instead of double-counting it as a separate row. Salesforce Link search on Log Activity gets a "Show Closed" checkbox (off by default) — previously there was no way to link to a Closed Won/Lost Opportunity at all
- **Attach Rate hardening (v1.276–v1.280)** — see §13 Coverage (a dashboard group missing from this doc entirely until this pass — also newly documented: the Infrastructure group). Selecting a Team member/Subteam now recomputes the whole rate via `sf_user_alignments` cohort narrowing, not just the breakdown card; SE Credit and Rep Coverage both get expand/collapse; a credited SF person with no matching ImpactIQ account renders in red (same convention as §9's SF preview popover); and a real false-positive was fixed where name-valued credit (org's Assigned SE field is a picklist, not a User lookup) was never actually checked against the roster, so it always showed red even for a fully-linked user — plus a follow-up fix for a separate display-only name cache that still leaked a raw UUID after the resolver fix landed
- **Assigned SE / Primary Engineer resilience + Project Primary Engineer (v1.279, v1.282, v1.285–v1.286)** — see §9. The Opportunity preview and nightly refresh now resolve whichever field shape a team's mapping actually uses (flat picklist vs. User-lookup relationship path) and fall back to the canonical flat field names when the mapping resolves to nothing. New `eval_primary_engineer` app field surfaces Primary Engineer on the Project preview too; since that Salesforce field is a genuine `Lookup(User)` (unlike Opportunity's picklist-shaped Assigned SE), its raw value is auto-resolved from a Salesforce Id to a name using `sf_field_mappings.reference_to` metadata the admin UI already captures — no new config needed
- **Migration journal integrity (v1.285)** — found and fixed two migrations (0137, 0138) that existed as `.sql` files but were never added to `drizzle/migrations/meta/_journal.json`, which is what `drizzle-orm`'s migrator actually reads — both were silently never applied to any database despite shipping in earlier PRs. **When adding a migration, the journal entry is not optional bookkeeping — a migration without one never runs, with no error.**
- **Nudge Rules + Scheduling admin power tools (v1.283–v1.284)** — Trigger Type and Trigger Config JSON become editable on an existing Nudge Rule (previously creation-only); every Scheduling job except `historical_backfill` gets a **Run now** button that invokes the exact same task the scheduler would run on its next tick
- **Nudge polish (v1.287)** — see §11. New `{days_since_activity}` rich token; the weekly-view nudge card splits its single dismiss into **Snooze** (1/7/30-day picker) and **Close out** (permanent — required making `nudge_dismissals.expires_at` nullable). Nudge delivery via Microsoft Teams was scoped and designed but deliberately not built this round — see §11 for the recommended approach and the one open blocker (confirming the org's Teams tenant webhook format) before starting it
- **Go-live security hardening pass (v1.288)** — a full read-only audit (auth, RBAC, secrets, injection surfaces, headers, deps) found five real cross-team/cross-tenant data-scoping gaps, all fixed: (1) the MCP server (§21, `mcp.ts`) read every tool tenant-wide with no team/user scoping at all — `dashboards.manager_rollup`, `activities.list`/`.get`, `users.list`, `teams.list` now all scope to `getAccessibleTeamIds(context.userId)`, and `salesforce.search_opportunities` now uses the calling user's own SF connection (never the admin one) with the same Assigned-SE-family filter the in-app search defaults to; (2) `POST /auth/api-keys` let any Contributor self-issue an `mcp:read` key with no role check, turning (1) into a self-service bypass — now requires leader/admin/team_admin/app-admin (new `hasAnyLeaderOrAdminRole()` in `rbac.ts`, shared with `requireAnyLeaderOrAdmin`); (3) the three History dashboard routes (`history-overview`/`-accounts`/`-coverage`) are gated by `requireAnyLeaderOrAdmin` (leader/admin on *any* team) but trusted a client-supplied `?teamId=` unchecked — the exact "chip renders vs. chip is enforced" bug class from the v1.245/v1.265 audits, recurred here; new `assertTeamIdAccessible()` closes it; (4) `GET /admin/users` returned the full tenant roster (including MFA status, admin flags, SF linkage) to any team_admin regardless of their own team scope — now filtered to users who share a team with the caller (app admins/`canSeeAllTeams` unaffected); (5) `GET /admin/teams` had the same gap despite every mutating route on the same resource already being `requireAppAdmin` — fixed by scoping the result set rather than locking the route, since several Team-Admin-accessible config screens (Cost/Capacity Groups, User Management, Holiday Calendars, Activity Templates) depend on it for their own team picker. **Recurring lesson across (3)/(4)/(5): a route's own gate (which roles get in) and its query's actual scoping (what data comes back once they're in) are two separate things — verify both, not just the gate, on any new endpoint that touches cross-team data.**
- **Security hardening pass, fast-follows (v1.289)** — the five lower-severity findings from the same audit. (1) `POST /auth/login` and `POST /auth/forgot-password` were rate-limited by source IP only, so a distributed attacker (many IPs / a VPN pool) faced no per-account ceiling — new `loginByEmailLimiter`/`forgotByEmailLimiter` key on the attempted email address instead, closing that gap regardless of source IP. (2) Outbound email token substitution (`rule-sender.ts`'s `interpolate()`) is now HTML-escaped by default — a token like `{{userAgent}}` is the raw client-controlled `User-Agent` header, and was substituted into `bodyHtml` unescaped; the one legitimate exception (`itemsList` in `digest.ts`, which intentionally carries pre-built `<ul><li>…` markup) opts out via an explicit `rawHtmlKeys` set rather than being a blanket exemption. (3) Theme-logo uploads (`admin.ts`'s `validateLogoDataUrl`) now share product-icon's MIME allowlist — previously any `data:` URI was accepted, including e.g. `data:text/html;...`, which the unauthenticated `GET /public/theme-logo/:themeId/:variant.png` route then served back with that same Content-Type verbatim; `logo.ts` also re-validates the stored MIME at serve time and sets a locked-down CSP (`sandbox`) + `nosniff` on that response as defense in depth for the `image/svg+xml` case specifically (SVG can embed `<script>`, which would execute if the URL were navigated to directly). (4) The `manager-rollup` dashboard's error path returned a stack trace to any Team Leader in every environment — now App-Admin-only. (5) SF Field Mapping create/update/delete had no audit trail at all despite being exactly the kind of change that can silently misdirect or blank a Salesforce write with no sync-time error (§9) — three new `sf_field_mapping.*` `AuditAction`s, with a before/after diff on update that the existing Audit Log page's diff-table renderer picks up automatically (no UI change needed, just matching the `{before, after}` meta shape it already knows how to render).
- **Nudge notification bell fixes (v1.290)** — two real gaps surfaced while walking through what each nudge action actually does. (1) `DELETE /api/notifications/:id` ("Dismiss"/X in the bell) only deleted that one row with no rule-level mute — since `syncNudgeNotifications` re-evaluates and re-upserts on every 60s poll (and every page load), a dismissed nudge whose trigger still held simply reappeared moments later, unlike Mark read (which suppresses the rule until next UTC midnight) or Snooze (N days). Dismiss now also calls the same `suppressNudgeForDay()` helper Mark read uses; the client's `dismiss()` also now fires `announceNudgeRead()` so the Weekly-view banner drops the same nudge immediately instead of waiting for its own poll. (2) The Nudge Rules admin editor's optional "AND / OR conditions" combinator field can hold a clause with the *same* `triggerType` as the rule's own base Trigger Type, each with independent config — both must match for the rule to fire, so if their settings disagree (e.g. different `days`) the stricter one silently wins with no indication why. `NudgeRulesConfig.tsx` now shows an inline amber warning when this happens. Note for future debugging: the field's placeholder example text (`{"op":"AND","clauses":[{"triggerType":"no_activity_days","config":{"days":3}}]}`) renders in the same gray as a real saved value at a glance — check `rule.conditions` is actually non-null before assuming a combinator is in play, not just what's visually in the box.
- **Nudge action tooltips + Preview dismissal diagnostic (v1.291)** — direct follow-up feedback on v1.290. (1) Every nudge action button (bell's Mark read / Snooze / Dismiss, weekly-view card's Snooze / Close out) now carries a distinct, honest `title` tooltip explaining what clicking it actually does — critically, Mark read and Dismiss (bell) are now described identically ("won't remind you again today, but returns tomorrow if still relevant") since v1.290 made them behave identically, while Close out (weekly-view X) is described as permanent so it reads as clearly different from the bell's same-day Dismiss despite both using an X icon. New `notifications.mark_read_tip`/`snooze_tip`/`dismiss_tip` and `nudge.close_out_tip` i18n keys across all 7 locales; the bell's dismiss tooltip is conditional on `n.kind === 'nudge'` since dismissing a non-nudge notification (e.g. a sync-failure alert) really is final, with no re-sync loop recreating it. (2) The admin Nudge Rules Preview endpoint (`GET /teams/:teamId/nudge-rules/:ruleId/preview`) already silently excluded any member with an active dismissal for that exact rule (`evaluateNudges`'s own dismissal filter) — which from the admin's side was indistinguishable from "genuinely doesn't match right now," and was reported as "no_activity_days still not working" when the real cause was earlier testing having snoozed/closed the rule for the only team member. The route now separately counts active dismissals among the sampled members (`dismissedCount`) and evaluate errors previously only `console.warn`'d (`errorCount`), and the Preview modal surfaces both as an inline note when hits are empty — turning an opaque "0 results" into an actionable diagnostic. `no_activity_days` itself was re-confirmed working as coded during this investigation: a rolling N-day window on `activities.created_at` (not week-scoped, and unrelated to Outlook/calendar connection — it only ever reads the `activities` table).
- **Nudge dismiss-model rework: three actions, one exclusive to the bell (v1.292)** — direct follow-up on v1.291's tooltip pass, once actually testing it surfaced that v1.291's own model was wrong, not just under-explained. New unified design across all three nudge surfaces (bell, weekly-view card, bottom toast) — see §11's rewritten "Three dismiss actions" note. (1) The bottom toast previously showed one bare X with no tooltip that silently behaved like Mark read; it's rebuilt to show the same Mark read (check) + Snooze (bell) icon pair as the other two surfaces, with a real snooze day-picker. (2) The weekly-view card's X ("Close out", permanent) is removed — replaced with a Mark read checkmark, matching the toast. (3) The bell's X now means **Close out** (permanent) instead of v1.290's same-day mute — that same-day-mute behavior moved to the checkmark, which now does the same thing everywhere (`services/nudge/dismissals.ts`'s new `muteNudgeRuleUntilNextUtcMidnight()`/`closeOutNudgeRuleForever()` helpers, extracted so all three surfaces share one implementation instead of drifting). Permanent close-out is deliberately kept exclusive to the bell — the weekly-view card and toast are quick-glance surfaces, and a reminder shouldn't be silenceable forever from one of those by a stray click. New `POST /api/nudges/mark-read { ruleId }` route backs the card's and toast's checkmark, since neither has a `notifications` row to key off the way the bell's `PATCH /api/notifications/:id/read` does; `POST /api/nudges/dismiss` no longer accepts a `permanent` flag now that nothing client-side sends one. The now-dead `notifications.dismiss_tip` i18n key was removed (7 locales) rather than left stale.
- **Total Bookings business breakdown on the activity form (v1.293)** — see §9. Renamed the
  activity form's `$ ACV (Annual Contract Value)` section to `$ Total Business`; moved the
  Sales Stage/Forecast/Close Date gray strip above it, directly under the Salesforce Link
  picker; added a chevron that expands it into New Business / Renewals ACV & TCV, fetched live
  (refresh on open) by reusing the existing Opportunity preview endpoint rather than a new one.
  Four new read/refresh-only SF Field Mapping app fields back the 4 numbers, inert until an
  admin maps them. The editable Total ACV field gained a label for visual parity with the
  read-only Opp Amount (SF) box beside it, with no change to its editable/locking behavior.
- **Nudge cross-surface sync fix + `{days_overdue}` token + Total ACV field polish (v1.294)** —
  three direct follow-ups from testing v1.290–v1.293. (1) See §11's rewritten "Two real gaps"
  note: the bell's Snooze was accidentally ALSO permanently closing rules out (a stale
  `DELETE /api/notifications/:id` cleanup call collided with v1.292's repurposing of that same
  route), and Mark read/Snooze from the weekly-view card or toast never touched the underlying
  bell notification row server-side, so a poll or reload could resurrect what looked dismissed.
  Both fixed by moving the notifications-row sync into `services/nudge/dismissals.ts` itself,
  shared by all three actions regardless of which surface calls them. (2) `stage_no_type`,
  `type_no_followup`, and `opportunity_stale` now support a new `{days_overdue}` token — the
  REAL elapsed days for the specific record (not capped at the admin's configured threshold),
  computed from that record's actual last-relevant-activity date rather than assumed to equal
  `{days}`. Seeded default templates for the first two now use it; an existing team's
  already-customized message needs an admin to add the token manually to pick it up. (3) The
  activity form's Total ACV field (§9, v1.293) is restyled to fully match the read-only Opp
  Amount (SF) box beside it — "(SF)" added to the label, dashed/gray box styling, and the
  displayed value now comma-formats when the field isn't focused.
- **Nudge Rules Preview: per-member activity evidence + Validate & dry run scope clarified
  (v1.295)** — direct follow-up after v1.294's dismissedCount/errorCount diagnostic came back
  clean (0 dismissed, 0 errors) and `no_activity_days` was *still* reported as showing nobody,
  including a specific user who — per the admin — "hasn't logged anything in days." The
  dismissedCount fix ruled out stale dismissals as the cause but gave no way to see the actual
  number the trigger is keyed on, which was the one piece of evidence that would settle it. The
  admin preview endpoint (`GET /teams/:teamId/nudge-rules/:ruleId/preview`) now additionally
  returns `activityDiagnostics` — every sampled member's most recent `activities.created_at`
  for the team, computed the same way `no_activity_days` and `{days_since_activity}` do — and
  the Preview modal renders it as a plain list ("Jane Doe — today") whenever the previewed
  rule's `triggerType` is `no_activity_days`, gated to that trigger only so other rule types
  don't pay for an unused query. This turns "trust the logic" into "here's the literal number,
  judge for yourself" — most likely explanation for a fresh/test team is that the *app itself*
  creating records while a user clicks around (drafts, test activities, form edits) counts as
  recent activity by design, which reads very differently from "logged real work today" to
  someone testing the feature. Also documented (no code change): the §9 Validate & dry run
  panel only checks Event/Task write-back mappings, derived from the team's active activity
  types — it has never validated Opportunity-scoped read/refresh-only mappings (Assigned SE,
  Primary Engineer, the Total Bookings breakdown fields) and was never intended to, since none
  of those feed `buildSfRecord()`'s write payload.
- **Validate & dry run widened to every write-capable object + ACV read-only bug fixed + SF
  write-path audit (v1.296)** — direct follow-up: the admin's next question was "does Run
  check test every object configured to write back, or just Event/Task?" It was Event/Task
  only — see §9's rewritten Field Mapping Validation & Dry Run scope note. Any object with an
  active `write`/`read_write` mapping now gets its own static + describe-layer section
  (Opportunity, Evaluations__c today); the dry-run payload preview stays Event/Task-only
  (`buildSfRecord()` can't build a payload for an arbitrary object) with an explicit
  `dry_run_unavailable` note instead of silently showing nothing. Investigating that surfaced
  a real bug in the same area: the ACV secondary write-back to Opportunity (`writeback.ts`)
  fell back to a hardcoded `Total_Acv__c` whenever no active write mapping existed, so marking
  `acv` read-only in the admin UI had no actual effect — fixed to skip the write entirely in
  that case. A follow-up question ("Assigned Oppty SE shows read-only in Field Mappings, so how
  does it write?") led to a full audit of every `conn.sobject(...).update/create` call outside
  `writeback.ts`/`fieldPrepend.ts`: the Evaluation field editor and the field-prepend route both
  correctly resolve through `sf_field_mappings`; the Assigned SE picker's write
  (`PATCH /opportunities/:id/assigned-se`) does not — it hardcodes `Assigned_SE__c` and ignores
  the `assigned_se_name` mapping entirely, which only ever drove the read side. Documented as a
  known exception in §21 rather than fixed outright, since a real fix needs a design decision
  (a dedicated write-target app field) rather than a mechanical change.
- **Keyword/Nudge Rule team-assignment junction bug fixed (v1.297)** — see §11's new note. The
  admin's report was that a `no_activity_days` Nudge Rule's Preview showed "0 of 4 members
  match" despite the per-member activity-evidence diagnostic (v1.295) proving 3 of the 4 were
  unambiguously overdue (two had never logged, one 37 days ago). Root cause: `evaluateNudges()`
  resolved which rules apply to a team by filtering `nudge_rules.team_id` directly, but every
  admin route for assigning a rule to teams (`POST`/`PATCH .../nudge-rules`, the "Assign to
  teams" picker) only ever wrote to the `nudge_rule_teams` junction table — the same table the
  admin list route already reads from. A rule reassigned after creation stayed visible and
  editable in the admin UI (junction-backed) but silently stopped being evaluated for real users
  on the newly-assigned team (`team_id`-backed) — a rule that LOOKS like it belongs to a team
  can, since some earlier edit, not actually run for it. `matchKeywords()` in `classify.ts` had
  the identical bug for Layer 1 keyword classification, found by checking whether the same
  junction/column split existed there too — it did, unfixed until this same pass. Also fixed:
  the "duplicate team" clone route read source rules by the stale `team_id` column (silently
  skipping any rule only junction-assigned to the source team) and never wrote a junction row
  for the copies it did make (leaving cloned rules invisible in the new team's own admin list,
  since that list is junction-backed too). All three fixed by making every read/write of
  "which team(s) does this rule belong to" go through the junction table consistently.
- **Assigned Oppty SE read/write field surfacing (v1.298)** — direct follow-up on the v1.296
  audit, which flagged but didn't fix this. See §9's new "Assigned Oppty SE — read/write field
  surfacing" note. The activity edit drawer's Assigned SE picker turned out to be a third,
  wholly separate code path from the two `assigned_se_name`-driven readers (Inline Preview,
  nightly refresh) — its own read AND write both hardcoded SF field names and never consulted
  `sf_field_mappings` at all. Fixed with a new, dedicated `assigned_se_write` app field (kept
  separate from `assigned_se_name` because that mapping can legitimately point at a read-only
  relationship path) — falls back to the canonical `Assigned_SE__c` when unmapped, so no
  existing team's behavior changes until an admin opts in. Also added a `teamId` parameter to
  all three endpoints in this family, which previously had no way to know which team's mapping
  to consult at all. While building the resolver, caught the same `team_id`-column-vs-junction
  bug from the v1.297 nudge/keyword fix trying to sneak into brand-new code (`sf_field_mappings`
  has the identical `sf_field_mapping_teams` junction split) — fixed there before it shipped, and
  found + fixed the same pre-existing gap in the "duplicate team" clone route for
  `sf_field_mappings` while in the area (the real write pipeline, `writeback.ts`, and
  `mappingValidation.ts` were already junction-correct, so this was narrower than the nudge/
  keyword case — only the clone route needed it).
- **SF Field Mappings Export / Import (v1.299)** — see §14's new bullet. App Admin can download a
  team's entire mapping configuration as JSON (every checkbox, R/W direction, constant value, and
  team assignment as portable slugs) and re-import it — into the same team, a different team, or a
  different install. Requested as a faster, more reliable alternative to hand-configuring a new
  team or baking one team's org-specific field names into the seed. Import is preview-then-apply:
  `POST .../import/preview` diffs the file against current live state field-by-field before
  anything is touched, which is what answers "call out any issues when there's been a change
  since it was exported" — a stale file overwriting a colleague's more recent edit shows up as an
  explicit before/after in the diff, not a silent overwrite. Apply re-diffs against current state
  rather than trusting the preview's snapshot (the DB can move between preview and apply), and is
  additive-only: no deletions, and team assignment is only ever added to, never removed. Piggybacks
  on the existing `sf_field_mapping.create`/`.update` audit actions with a `source: 'import'`
  marker rather than adding new audit-log plumbing.
- **Validate & Dry Run false-positive pass (v1.300)** — see §9's new bullet. Direct admin feedback
  after using the widened (v1.296) panel for real: the Evaluations__c section showed almost
  nothing useful despite the object having several genuine write mappings, Task showed 4 "missing
  required field" errors despite having only 1 mapping and zero active types, and two Event
  mappings (`Assigned_To_Name__c`, `Subject`) showed errors the admin's own testing said weren't
  real. All three were real bugs in the checker, not the mappings: describe-driven correctness
  checks ran against app fields nothing actually sends to Salesforce (false "will reject the
  record" errors); `eval_engineer_notes`/`eval_next_steps`/`assigned_se_write` have real write
  paths outside `buildSfRecord()` that the checker didn't know about, so they were misfiled as
  unused; `combobox` (Subject's real SF type) was missing from the accepted types for a string
  value; and the required-field check didn't account for an object having zero active types
  routing to it. Fixed all four — see §9 for the detail.
- **`evaluation_lookup` hardcoded field name fixed (v1.301)** — found while explaining the
  seeded `evaluation_lookup` mapping (`sf_field_mappings`, migration 0087, `Evaluation__c` by
  default) to an admin who asked what it was for and noticed the Validate panel flagging
  `'Evaluation__c' doesn't exist on this object` for their org. `refreshOppSnapshots.ts` read
  `rec.Evaluation__c` as a hardcoded literal regardless of what this mapping was actually
  configured to — the identical "never hardcode SF field API names" violation the Assigned SE
  picker had (§9/§21) — so remapping it to the org's real Project/Evaluation lookup field name
  had no effect, and on an org where the field genuinely isn't named `Evaluation__c`, the nightly
  refresh of `activities.sf_related_id` (which keeps a logged activity's linked Project current
  if it changes in Salesforce later) silently did nothing. Now resolved via
  `resolveAppFieldPaths()` like `assigned_se_name`/`primary_engineer_name`, falling back to the
  literal `Evaluation__c` only when the mapping is missing/inactive — same fallback contract as
  before for teams that never touch it.
- **Audit Log target names + Action filter completeness (v1.302)** — see §14's new bullet. Two
  admin-reported gaps: (1) the Target column showed a bare UUID for `sf_field_mapping` rows
  instead of anything readable — `GET /admin/audit`'s name resolver only ever handled
  `team`/`user`; extended to `subteam`/`activity` (id lookup) and `sf_field_mapping` (a label
  built from the row's own `meta`, since a mapping has no standing name to look up and a
  deleted mapping's row is already gone). (2) The Action filter dropdown was a hand-maintained
  subset that had drifted to 17 of 47 real logged actions — every action added across this
  entire session (historical import, work week approvals, most integration saves/clears, etc.)
  was silently unfilterable. Both the server's `AuditAction` type and the client's dropdown now
  import the same `src/shared/auditActions.ts` array, so a new action is filterable the moment
  it's added there — no second list to remember.
- **Nudge Rules Preview: rule-eligibility diagnostic (v1.303)** — direct follow-up after the
  admin reported `no_activity_days` (`{"days":5}`) STILL showing "0 of 4 members match" against
  the same provably-overdue roster from v1.295–v1.297, even after the junction-table fix (§11)
  was confirmed live on `main`. The admin also asked a sharp, specific question that needed a
  precise answer: does the trigger only match users inactive for *exactly* the configured number
  of days, or does it correctly treat the config as a floor ("N days or more")? Re-confirmed by
  code walkthrough: `since = startOfDay(subDays(now, days))` with `gte(activities.createdAt,
  since)` is unbounded above — someone inactive 38 days already satisfies "≥ 5 days," so that
  wasn't the cause. With every per-user hypothesis exhausted (dismissals, cooldown, AND/OR
  conditions, and now the day-comparison direction itself, all individually ruled out and
  previously fixed where real), the remaining open question was strictly binary: does this rule
  even reach the per-user trigger check for this team at all? The preview route now answers that
  directly instead of leaving it inferred — `ruleEligibleForTeam` runs the *exact* junction
  join `evaluateNudges()` uses (`nudge_rule_teams` × `is_active`) and returns the boolean
  straight to the admin, rendered as a blocking red banner at the top of the Preview modal when
  false ("nothing past this point can fire for this team until that's fixed") — so the next
  report is either "this banner is red, and that's the whole bug" (a genuinely new, now-provable
  gap) or "this banner is green," which would mean the per-user logic itself needs fresh eyes
  with that ambiguity finally closed off.
- **Nudge Rules Preview: per-user recentCount ground truth (v1.304)** — the banner from v1.303
  came back green (rule genuinely eligible for the team) and the admin confirmed `no_activity_days`
  is unambiguously a floor, not an exact match, ruling out the last remaining per-user hypothesis
  by pure code-reading. Every individual piece of `evaluateNudges()` — the junction join,
  dismissals, cooldown, AND/OR conditions (re-confirmed still just placeholder text, not a saved
  value), and the `no_activity_days` query itself — has now been read and re-read and is
  internally consistent; nothing in the source explains the live symptom. Rather than propose a
  sixth speculative fix, the Preview route now runs the *exact* `count(*)` query
  `no_activity_days` itself runs per sampled member (same table, same `gte(createdAt, since)`
  comparison, batched in one round trip) and returns it as `recentCount` alongside the existing
  last-activity date — rendered as a small green/gray pill per member in the diagnostics list.
  If `recentCount` ever disagrees with what the last-activity date implies (e.g. a "38 days ago"
  member showing a non-zero count), that is direct proof of a live-query-level anomaly rather
  than trigger logic, since the logic has been exhausted; if it agrees (reads 0) and the member
  still doesn't appear in the hits list above, that points at something between the trigger
  condition evaluating true and the notification actually reaching the response — the next area
  to inspect with this data in hand, and not one this investigation has looked at closely yet.
- **Nudge Rules Preview: per-member dismissal state (v1.305)** — direct follow-up after the
  admin reported the real notification bell showing this exact symptom for a real user: other nudge types (`stage_no_type`, `type_no_followup`) delivered correctly, but
  `no_activity_days` never did, even with `recentCount: 0` now confirmed for him via v1.304's
  diagnostic — proving the trigger's own query says he should match. Re-reading `evaluateNudges()`
  end to end (the `no_activity_days` emit, the leader-rollup pass, and the final rich-token
  substitution pass that produces the return value) found nothing that drops or eats a
  `no_activity_days` notification once `emit()` has been called for it — every line downstream of
  that point is generic across trigger types and already proven correct for the same user's other
  nudges in the same call. That leaves exactly one gate that runs *before* the trigger check ever
  executes and is invisible per-member today: `if (dismissedIds.has(rule.id)) continue` (line 229).
  The Preview route already computed an aggregate `dismissedCount` (v1.291) and rendered a note
  when it's non-zero, but never said *which* members — a member whose `recentCount` independently
  proves the condition true, but who also has their own active snooze/close-out on this exact
  rule (highly plausible for these specific long-lived test accounts after this many rounds of
  UI testing across the session), looks from that note alone identical to "genuinely doesn't
  match." `activityDiagnostics` now also carries `dismissed: 'permanent' | 'snoozed' | null` and
  `dismissedUntil` per member (same dismissal query already run for the aggregate count, just
  keyed per-user instead of collapsed to a `Set` size), rendered as an amber pill next to the
  `recentCount` pill in the Preview modal. This turns "the aggregate note didn't fire, so it must
  not be dismissals" into "here is the literal per-member state" — either the pill lights up next
  to the exact members failing to appear (closing the investigation: their own snooze/close-out
  is the answer, and the fix is clearing it, not more engine code), or it stays absent everywhere
  even though `recentCount` reads 0 and no hit appears, which would finally point conclusively at
  the one area not yet inspected — between "trigger condition evaluates true" and "notification
  reaches the response" inside `evaluateNudges()`'s per-rule `emit()` call itself.
- **Nudge Rules Preview: rule-wide gate diagnostics (v1.306)** — the v1.305 per-member dismissal
  pill came back blank for every sampled member on the admin's actual rule, ruling out a stale
  snooze/close-out as the cause. That result itself is informative: a per-member cause (a
  dismissal, a per-user cooldown) cannot explain a "0 of N" that is perfectly SYMMETRIC across
  every member regardless of their own `recentCount` — only a gate that applies to the rule as a
  whole, independent of who's being evaluated, can produce that shape of result. Re-reading
  `evaluateNudges()` with that framing found exactly one such gate not yet surfaced anywhere:
  `if ((rule as { leaderRollupThreshold?: number | null }).leaderRollupThreshold != null) continue`
  (line 234) — when this column is non-null, the ENTIRE per-user emission path is skipped
  unconditionally for every single member, before the trigger check ever runs. A rule in this
  state can only ever fire via the separate leader-rollup pass, which itself counts distinct
  users nudged via `nudge_events` in the last 7 days — rows that only the (now-skipped) per-user
  path would have written, a self-defeating trap for a rule not actually intended as a rollup.
  The Preview route now returns `isLeaderRollupRule`/`leaderRollupThreshold` (the raw column
  value, ground truth rather than an inference from eyeballing the admin form) alongside a new
  `hasConditions` flag (does this rule's `conditions` JSONB actually have a non-empty `clauses`
  array, as opposed to looking like it might from placeholder text) and `cooldownHours`. The
  modal renders a red blocking banner identical in weight to the v1.303 eligibility banner when
  `isLeaderRollupRule` is true, and a softer amber note when `hasConditions` is true (informational
  — a real AND/OR condition isn't necessarily a bug, just a fact worth checking against). This is
  the natural next rung on the same ladder this whole investigation has climbed since v1.291: stop
  asking the admin to trust an inference or eyeball a form field, hand back the literal value that
  settles the question.
- **Push to Salesforce Notes from the activity drawer (v1.307)** — see §9's new "Push to
  Salesforce Notes from the activity drawer" note. My Notes' existing **Push to Salesforce**
  ContentNote mechanism (`POST /api/notes/:id/push`) is now also reachable as **Post: Opp Notes**
  / **Post: Acct Notes** checkboxes directly on the activity drawer — both the edit-mode Notes tab
  and the create-mode inline Notes field — right below the existing Engineer Notes checkbox, so a
  single note submission can push to Engineer Notes, Opp Notes, and Acct Notes all at once. Acct
  Notes rolls up through a linked Opportunity's cached parent Account
  (`activities.sfAccountId`/`sfAccountName`), unlike My Notes' own Push modal, which only offers a
  direct Account link — a deliberate scope difference since most activities link to an
  Opportunity, not an Account, so a direct-only Acct Notes checkbox would rarely have shown at all.
- **`no_activity_days` root cause found and fixed: bigint-as-string comparison (v1.308)** — the
  actual bug behind the entire v1.291–v1.306 investigation. `evaluateNudges()`'s per-user
  `no_activity_days` check ran `if ((recent?.count ?? 0) === 0)` against a `count(*)` query result.
  Postgres `count(*)` returns `bigint` (OID 20); the `postgres` driver this app uses (no custom
  type parser configured in `db/index.ts`) returns bigint columns as a JavaScript **string** at
  runtime specifically to avoid silently losing precision above `Number.MAX_SAFE_INTEGER` — and
  Drizzle's `sql<number>` annotation is a compile-time TypeScript assertion only, it does **not**
  coerce the actual runtime value. So the comparison was really `"0" === 0`, which is always
  `false` under strict equality — this trigger could never fire, for any user, on any team,
  regardless of rule config. It was never a config problem at all, which is exactly why every
  diagnostic built across v1.291–v1.306 (dismissals, cooldown, AND/OR conditions, team
  eligibility, leader-rollup, the day-comparison direction, per-member ground truth) kept coming
  back clean — none of them were checking the right line. It's also exactly why `stage_no_type`
  and `type_no_followup` worked correctly the whole time: neither uses a raw `count(*) === 0`
  comparison: they iterate result rows and check `Set.has()`/array membership instead. Every OTHER
  `count(*)` comparison in `engine.ts` (the four inside `matchesTrigger()`, plus `sf_sync_failed`'s
  and `product_gap`'s main-loop checks) already wrapped the result in `Number(...)` before
  comparing — this was the one unguarded exception, found by literally reading every `count(*)`
  usage in the file side by side and noticing the one line that didn't match the pattern of all
  the others. Fixed with a one-line `Number(recent?.count ?? 0) === 0`. **Lesson for any future
  `count(*)`/`sum()`/other aggregate query against this driver: `sql<T>` is a type-level promise
  to TypeScript, not a runtime cast — always wrap a driver-returned aggregate in `Number(...)`
  before comparing it numerically, and grep for the bare pattern (`?? 0) === `/`?? 0) >= ` without
  a `Number(` immediately before it) if a trigger/aggregate-driven check is ever reported as
  "never fires" again.**
- **Pre-launch hardening pass, part 1: shared meeting-load predicate (v1.309)** — first of several
  follow-ups from an ~80-user rollout health check. `isRealMeetingLoad()` moved from
  `services/capacity/meetingLoad.ts` to `src/shared/meetingLoad.ts` so `WeeklyView.tsx`'s own
  `otherMeetingHours` math (§12.1) imports the exact same predicate the server uses instead of a
  hand-duplicated copy that only excluded `alreadyLogged`/`isAllDay` — closing the client-side gap
  §12.1 had explicitly deferred. Pure client-side fix; the client already had every field the
  predicate needs.
- **Pre-launch hardening pass, part 2: Nudge Dismissals admin page (v1.310)** — see §14's new
  bullet. The only place a dismissal was ever surfaced to an admin was the Nudge Rules Preview
  modal's per-member pill; this ships a standalone, team-scoped page listing every member
  currently snoozing or permanently closed out of a nudge rule, with a Clear action. Same
  `team_members`-join team-scoping pattern as Preview (`nudge_dismissals` has no `team_id`
  column), same `requireRole('admin')` gate as every other nudge-rules route. Clearing removes
  every dismissal row for the pair, not just the latest, since a user can accumulate more than
  one over time with no unique constraint or upsert on insert.
- **Pre-launch hardening pass, part 3: real test coverage begins (v1.311)** — this repo had exactly
  one test file (`src/shared/sfFieldPrepend.test.ts`, pure functions only) before this. Adopted
  `@electric-sql/pglite` (an in-memory, wire-protocol-compatible Postgres) for DB-touching tests
  on the riskiest code — `src/server/db/testDb.ts`'s `createTestDb()` spins up a fresh instance and
  applies the real migration history by reading `meta/_journal.json` and running each `.sql` file
  through PGlite's `.exec()` (simple query protocol, handles multi-statement files) rather than
  `drizzle-orm/pglite/migrator`'s `migrate()` (extended/prepared-statement protocol, which — like
  real Postgres — rejects a single prepared statement containing more than one SQL command; several
  migration files here have two statements with no `--> statement-breakpoint` between them). A test
  file mocks `db/index.js` (`vi.mock('../../db/index.js', async () => ({ ...await
  vi.importActual(...), db: await createTestDb() }))`) so the service file under test — e.g.
  `nudge/engine.ts` — runs completely unmodified against pglite, since `drizzle-orm/pglite` implements
  the identical query-builder API against the same `drizzle/schema.ts`. `testDb.ts` deliberately
  does NOT import anything from `db/index.ts` (duplicates the tiny migrations-folder-walk instead)
  to avoid a circular mock-resolution problem while a test file's own `vi.mock` factory is still
  executing.
  **Load-bearing gotcha, found and proven by a failing-then-passing test before relying on it
  elsewhere**: pglite's own default type parser returns `count(*)` as a real JS **number**, unlike
  the `postgres` driver this app uses in production (which returns bigint/OID 20 as a **string** —
  the exact behavior behind the v1.308 `no_activity_days` bug). `drizzle-orm`'s pglite session
  builds its query config internally with no hook to override that per-column, so this can't be
  patched away. Practical consequence: a pglite-backed test of `no_activity_days` verifies
  functional correctness (which member matches, joins, date boundaries) but **cannot** serve as a
  regression guard for the bigint-as-string bug class itself — reverting the `Number(...)` wrap
  would pass a pglite test identically. The actual guard for that lives in
  `engine.aggregateCoercion.test.ts`, a static source check (not a runtime test) that parses
  `engine.ts` and asserts every `count(*)`-backed comparison is wrapped in `Number(...)` — directly
  encoding the "Lesson" callout from the v1.308 footer. Verified to actually catch a reintroduction
  by temporarily reverting the real fix and confirming the test fails, then restoring it.
  `vitest.config.ts` widened from `src/shared/**/*.test.ts`-only to also include
  `src/server/**/*.test.ts`, with `hookTimeout`/`testTimeout` raised to 30s (a fresh pglite instance
  replaying 140+ migrations costs several seconds). First suite shipped:
  `nudge/engine.test.ts` (13 tests: trigger dispatch, the v1.297 junction-table team-assignment
  regression, dismissal expiry semantics including NULL-means-permanent, cooldown windows, and the
  AND/OR combinator — including the non-obvious fact that the combinator only ever *gates* whether
  the base trigger's own check runs, it can never substitute for that check, so an OR clause being
  true does not make a rule fire if the base trigger itself evaluates false).
- **Pre-launch hardening pass, part 4: test coverage completed + full i18n zero-gap (v1.312)** —
  closes out both remaining items from the ~80-user rollout health check.
  - **Test coverage** — four more suites, per the plan laid out in v1.311: `writeback.test.ts`
    (13 tests, plain unit tests — `buildSfRecord()` takes all its inputs as arguments with no
    internal I/O, so no pglite needed: SF object routing, read/refresh-only mappings never
    writing, a missing mapping omitting the field entirely rather than a hardcoded fallback,
    constants running last and overriding). `resolver.test.ts` (19 tests, pglite-backed: the
    user-override date-boundary is exclusive on `effectiveTo` and inclusive on `effectiveFrom`,
    all 4 capacity methods including `calendar_derived`'s trailing-average and its
    insufficient-history fallback, `self_declared`'s floor-at-group-target both directions).
    `anomalies.test.ts` (16 tests, pglite-backed — the highest-value suite here: explicitly proves
    the account-burn-spike detector's active-baseline-weeks-only average and the
    activity-type-surge/collapse detector's full-8-week-including-zeros average produce different
    numbers from the same fixture, the asymmetry §13 warns a "simplifying" refactor could silently
    break; also caught a real test-authoring bug during writing — a 3-active-baseline-week fixture
    tripped the *separate* `MIN_BASELINE_WEEKS`(4) gate and made `insufficientHistory` true,
    silently skipping the whole detector, which looked identical to "detector doesn't fire" until
    a debug run surfaced the actual `AnomalyResult.insufficientHistory` field). `mappingValidation.
    test.ts` (21 tests, pglite-backed since `buildPreview()` queries `activities`/`users` directly)
    — required exporting `validateOne()`/`MappingRow` (previously module-private), the same reason
    `buildSfRecord()` was exported in v1.219; includes the plan's most-valuable suggested test, a
    shared fixture run through both `validateOne()` and `buildSfRecord()` asserting they agree on
    picklist-fallback semantics (inactive-config → fallbackValue, missing-config-when-others-exist
    → dropped entirely), directly guarding the "mirror buildSfRecord's fallback semantics exactly"
    comment from silently drifting. All 100 tests across 8 files pass; `npx tsc --noEmit` clean on
    both `tsconfig.server.json` and the client config.
  - **`dashboards.ts` totalHours string leak fixed** — `/heatmap` and `/capacity-trend` sent
    `totalHours` to the client as the raw, un-coerced `sum(...)` string (same class of issue as the
    v1.308 bug, just never compared strictly so never triggered it); both now `Number(...)`-wrap
    before the response, matching `/this-week-capacity`'s existing convention. Confirmed harmless
    in practice — both `TeamHeatmap.tsx` and `CapacityTrend.tsx` already wrapped every read in
    `Number(r.totalHours)` — but the client `Row`/`HeatmapRow` interfaces are updated from
    `totalHours: string` to `totalHours: number` to match the corrected wire shape, removing a
    landmine for the next person who reads that type and assumes it's honest.
  - **i18n: the full 149-key gap closed, zero missing keys in any of the 7 locales** — the
    original per-locale breakdown from the health check (13 keys missing in every non-English
    locale, a reverse gap where `en` itself lacked `login.forgot_password` even though `es` had
    it, 26 password-reset-flow keys missing in `de/fr/ja/pt/it`, 7 `ja`-only + 1 shared `es`/`it`
    key, and 102 `it`-only keys including three wholly-missing objects — `sf_relationship`,
    `meddpicc`, `settings.teams`) is now fully closed; `scripts/check-i18n-parity.py` (new) does
    the same flatten-and-diff every locale against `en` that the original audit did by hand, and
    running it now reports zero missing and zero extra keys in all 6 non-English locales. **A
    second, distinct defect class was found while closing the `it` gap and is NOT yet fully
    fixed**: 314 keys across the 6 non-English locales (54 of them in literally every non-English
    locale) hold their **English source text as the actual stored value** — not a missing key, a
    real translation that was never written, invisible to any key-existence diff. Fixed for `it`
    specifically while already in that file (the `it`-untranslated subset, confirmed against
    what other locales use for the same key, e.g. `settings.timezone.*` was entirely
    untranslated English in `it` before this pass); the other locales' share of the 314 is
    unaddressed — a distinct, larger follow-up (translation content, not structure), not something
    to fix silently mid-task without the same explicit scoping the original 149-key sweep got.

- **Translated the `de` (German) share of the untranslated-in-place gap (v1.313)** — see §18
  Deferred/Roadmap's note below. ~115 keys across `admin.*` (fiscal calendar config, activity
  types, approvals, nudge rules), `errors.workweek.*`, `settings.timezone`/`work_week`/
  `worker_type`, `sf_relationship`, and misc dashboard/activity strings held literal English text
  as their stored value; all now hold real German. Two stray informal-tone (`du`/`dein`) lines this
  session had itself introduced in `settings.timezone.source_hint`/`switched_body` (v1.311's
  password-reset sweep) were corrected to the file's dominant formal `Sie` convention (245 `Sie`
  instances vs. 18 informal, confirmed by count before touching anything) while in the area.
  ~127 keys deliberately left untranslated in `de` — brand/product names (Salesforce, Slack, Azure
  OpenAI, Okta SSO, Microsoft Outlook), Salesforce object-name loanwords already used that way
  elsewhere in this exact file (`Account`/`Accounts`, `Opportunity`/`Opportunities`, `Lead`/`Leads`,
  `Team`), finance/status abbreviations (`ACV`, `TCE`, `FX`, `MFA`, `IP`, `OK`, `Δ`), established
  German tech loanwords (`Status`, `Job`, `Filter`, `Tool`, `Token`, `Slug`, `URL`, `Tooltip`,
  `Screenshots`, `Region`, `Domain`, `Website`, `Rotation` — all identical or standard loanwords in
  German), env var literals (`DATABASE_URL`, `SESSION_SECRET`, `APP_URL`), Salesforce/Okta portal
  field names (`Consumer Key`/`Consumer Secret`), the `Flight Deck`/`MEDDPICC`/`Champion`/
  `Engineer Notes`/`Non-Activity` proper-noun feature and methodology names, and pure numeric/
  currency-range filter labels (`$100K–$200K` etc.) — confirmed via cross-reference against
  dozens of already-correctly-translated instances of the same term elsewhere in `de.json`, not
  guessed. `fr`/`es`/`ja`/`pt` still carry their own share of the original 314-key gap.
- **Translated the `fr` (French) share of the untranslated-in-place gap (v1.314)** — same pattern
  as `de` (v1.313). ~115 keys across `admin.*`, `errors.workweek.*`, `settings.timezone`/
  `work_week`/`worker_type`, `sf_relationship`, and misc dashboard/activity strings now hold real
  French. `fr.json` runs noticeably more informal (`tu`/`ton`) than `de.json` (29 informal vs. 58
  formal `vous` instances, vs. `de`'s 18-vs-245 split) — treated as pre-existing and out of scope
  for a broader tone audit; only the 2 lines this session itself introduced in v1.311's
  password-reset sweep (`settings.timezone.source_hint`/`switched_body`) were corrected to formal
  `vous`, matching the `de` fix. ~130 keys deliberately left untranslated — the same
  loanword/brand/abbreviation categories as `de`, plus a `fr`-specific wrinkle: `sf.account`/
  `sf.opportunity` (the SF search-tab labels) and every other bare `Account`/`Opportunity`
  occurrence were left as English loanwords specifically because a sibling key in the same `sf`
  object (`my_filter: "Mes Opportunities/Accounts"`) already establishes that convention for this
  file — confirmed against that direct precedent, not the more common French translated forms
  (`Comptes`/`Opportunités`) that also appear elsewhere in `fr.json` in prose context. `es`/`ja`/
  `pt` still carry their own share.
- **Translated the `es` (Spanish) share of the untranslated-in-place gap (v1.315)** — same pattern
  as `de`/`fr`. ~110 keys across `admin.*` (fiscal calendar, activity types, approvals, nudge
  rules), `errors.workweek.*`, `settings.timezone`/`work_week`/`worker_type`, and misc
  dashboard/activity strings now hold real Spanish. `Status` translates to `Estado` throughout
  `es.json` (19 existing instances, zero English stragglers after this pass) — unlike `de`, which
  keeps `Status` as an established loanword. Bare `Account`/`Opportunity`/`Lead` in
  dashboard/filter contexts were kept as English loanwords, matching the same
  `sf.my_filter: "Mis Opportunities/Accounts"` sibling-key precedent used for `fr`, plus a
  dashboard-title precedent already in the file (`dashboard_account_burn: "Panel — Consumo
  Account"`); `Manager` was also left as a loanword (5 instances, no existing `Gerente` to match
  against). Dashboard-title strings follow the file's own established `"Panel — X"` pattern (not
  `Tablero`/`Dashboard`) — one straggler
  (`admin.role_mgmt.page.dashboard_products_breakdown`) was fixed to match it. The same 2 lines
  this session introduced in v1.311's password-reset sweep
  (`settings.timezone.source_hint`/`switched_body`) were corrected from informal `tú` imperative
  forms to the file's dominant formal `usted` imperative forms (`Elige`→`Elija`,
  `Puedes`→`Puede`) — `es.json` runs nearly even overall (76 formal vs. 67 informal, ~53%/47%),
  the closest split of any locale fixed so far, but the same narrow scope (only this session's own
  2 lines) applies. ~100 keys deliberately left untranslated — the same loanword/brand/
  abbreviation categories as `de`/`fr`. `ja`/`pt` still carry their own share.
- **Translated the `ja` (Japanese) share of the untranslated-in-place gap (v1.316)** — smallest of
  the six by far: only ~53 keys held literal English text as their stored value (vs. ~110-115 for
  `de`/`fr`/`es`), because `ja.json` already fully translates almost everything else — this locale
  establishes its own, much more thorough convention rather than following `de`/`fr`/`es`'s
  loanword-heavy pattern. Fixed across `admin.*` (fiscal calendar, activity types, approvals,
  nudge rules), `errors.workweek.*`, `settings.timezone`/`work_week`/`worker_type`,
  `sf_relationship`, and misc dashboard/activity strings. Unlike `de`/`fr`/`es`, `sf.account`/
  `sf.opportunity` and every other bare Account/Opportunity/Lead occurrence were translated into
  kanji (アカウント/商談/リード) rather than kept as loanwords — grep-counting confirmed this is
  overwhelmingly the established convention in `ja.json`, the opposite of the other three Western
  locales' sibling-key precedent. No tone fix needed: Japanese has no formal/informal address
  distinction analogous to `de`/`fr`/`es`'s Sie/vous/usted, and the `settings.timezone.source_hint`/
  `switched_body` lines this session introduced in v1.311 were already in consistent polite
  です/ます form. ~53 keys deliberately left untranslated: brand/product names (Salesforce,
  Microsoft Outlook, Okta SSO, Microsoft Graph, Azure OpenAI/SSO, Slack, Claude Desktop), env var
  literals (`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, `APP_URL`, `OKTA_DOMAIN` etc.,
  `SF_CLIENT_ID` etc., `MS_CLIENT_ID` etc., `AZURE_OPENAI_*`), abbreviations (`ACV`, `TCE`, `FX`,
  `MFA`, `IP`, `OK`, `URL`, `Δ`), proper nouns (`Flight Deck`, `MEDDPICC`, `Engineer Notes`,
  `Non-Activity`), currency-range labels (`$5K–$10K` etc.), and template-literal-only values
  (`{{hours}}h`, `{{month}}`, `{{asOf}}`). `pt` still carries its own share.
- **Two live bugs reported post-rollout, both fixed (v1.317)**: (1) A Nudge Rule Preview showed
  the literal, unsubstituted `{days}` token in the delivered message text for `no_activity_days`
  (e.g. "Nothing logged in the last {days} yet") — `engine.ts`'s `no_activity_days` branch called
  `emit(rule, rule.messageTemplate)` directly with no token substitution at all, unlike every
  other trigger type in the file. Auditing every other trigger's substitution while in the area
  found a second, broader bug: `stage_no_type`, `opportunity_stale`, `product_gap`,
  `type_no_followup`, and `weekly_hours_below_target` all used a plain string `.replace('{token}',
  value)` for `{opp_name}`/`{account_name}`/`{days}`/`{product_name}`/`{pct}`/`{hours}`/
  `{target}`/`{count}` — a string-pattern `.replace()` only replaces the FIRST match, so a
  template repeating the same token (e.g. "No Eval Work for {opp_name}... did you forget about
  {opp_name}?") left every occurrence after the first as a literal token. `{days_overdue}` was
  already correctly implemented as a global regex, and became the model for the fix: every one of
  these substitutions is now `.replace(/\{token\}/g, ...)`. New `engine.test.ts` regression tests
  cover both the `{days}` fix and the repeated-token case (via `sf_sync_failed`'s `{count}`).
  (2) User Management's Edit User panel could silently re-grant App Admin to a user who had just
  been demoted via the Role dropdown. `submitEdit()` in `UserManagement.tsx` spread the entire
  `editForm` — including `isAppAdmin` — into the `PATCH /api/admin/users/:userId` payload on
  every save. `editForm.isAppAdmin` is a snapshot taken once when the panel is opened
  (`openEdit()`, hydrated from the `allUsers` directory state), and that directory isn't
  refetched by `changeRole()` (the Role dropdown's own handler, which only updates the
  team-scoped `users` list). So the sequence "demote via Role dropdown, then save any unrelated
  field on an already-open Edit panel for the same user" resubmitted the stale pre-demote
  `isAppAdmin: true` and silently reverted the demote — exactly the "changing the role should
  reset it, but the app remembers" symptom reported. There's been no checkbox for `isAppAdmin` on
  this form since v1.94.0 (the Role dropdown is documented there as the sole control for it), so
  the fix strips `isAppAdmin` from the outgoing payload entirely unless the `isDefaultAdmin`
  checkbox is being explicitly turned on in the same save (which legitimately requires it).
  **If an account is already stuck with a stale `isAppAdmin=true` from before this fix shipped**,
  re-selecting its Role dropdown (even switching to a different role and back) re-triggers the
  server's existing, already-correct demote-sync in the `/role` PATCH endpoint and self-heals it —
  no direct DB edit needed.
- **User Management: Last Logged In column + cross-team "group by Default Team" view (v1.318)**
  — two features requested off the back of the same screenshot as the v1.317 role-demote bug.
  See §14's User Management bullet for the full writeup. `GET /api/admin/users` (the directory
  route feeding both the flat single-team list and the new grouped view) now also returns
  `lastLoginAt` (one `MAX(created_at)` over `login_events` grouped by user, filtered to
  successful logins — reuses the same table Login History reads, just reduced per user) and
  `teamRoles` (a `{teamId: role}` map built from the same `team_members` join the route already
  ran for `supportedTeamIds`, at no extra query cost). The grouped view only renders under the
  team selector's **All Teams** — previously a dead "select a specific team" prompt for this
  page — grouping every visible user by `defaultTeamId` into collapsible sections, each with a
  `<SubteamFilter>` scoped to that team's own subteams (same shared chip Dashboard/Scheduling
  use, with its own parallel `subteamMembersById` resolution — the shared component only exposes
  member data through its own internal expand-to-view UI, not back to the caller for filtering,
  so the parent independently fetches `GET /api/teams/:teamId/subteams/:id/members` for any
  subteam actually selected, same pattern as `Dashboard.tsx`'s own cache). The flat single-team
  view's Edit/Reset-Password inline panels were extracted into `renderEditPanel()`/
  `renderResetPasswordPanel()` (previously ~230 lines inlined once per row) specifically so the
  grouped view could reuse them verbatim rather than forking a second copy that could drift.
- **Meeting owner email, on the form and on hover (v1.319)** — a new `activities.meeting_owner_email`
  column (migration 0141), kept alongside the existing `meeting_owner` (name-only) column rather
  than folded into one combined string, so cards can render just the name and use the email only
  to disambiguate — two people can share a display name across different orgs. The Log Activity
  form's Meeting owner field now edits "Name <email>" (a single-entry reuse of the exact same
  `parseAttendees()`/`serializeAttendees()` convention Attendees already uses, via a new
  `meetingOwnerText` raw-input state mirroring `attendeesText`), and `SfContactOwnerPicker` sets
  both fields when a contact is picked. Both card surfaces (`ActivityCard.tsx` for logged
  activities, `SuggestedActivityCard.tsx` for not-yet-logged calendar suggestions) still render
  the name only, now with a native `title` tooltip showing the email on hover — no new UI chrome.
  The suggested-card path didn't need a new server field at all: `organizerEmail` (v1.240.0, added
  originally to resolve "am I required/optional" for a self-organized meeting) already carried the
  exact same value through the suggestion payload, so it's reused directly rather than duplicated.
  Never sent to Salesforce — `writeback.ts`'s free-text notes keep using `meetingOwner`'s plain
  name, same "ImpactIQ-only" convention as Subtypes (§7).
- **Team Activity Deep-Dive view toggle + Sales Team Alignment cross-team grouping (v1.320)** —
  two independent asks from the same feedback round. **Team Activity Deep-Dive** (§13) gets a
  two-icon segmented toggle (`ListChecks` / `Users`) to the left of the existing expand/collapse-
  all button, switching between the original Activity Type → Subteam → User → Subtype tree
  (default) and a new Subteam → User → Activity Type → Subtype tree with the first column header
  relabeled "SubTeam". No new query: `/team-activity-deep-dive` computes the alternate ordering
  from the same per-leaf aggregation maps the original tree already builds and returns it as
  `meta.bySubteamRows` alongside the existing `data`, so both trees are available in one round
  trip and the toggle is instant. The client's existing generic DFS tree renderer
  (`{id, parentId, depth, metrics}[]`, expand/collapse via a `Set<string>`) needed no changes to
  support the second tree — it only ever cared about the shape, not what each tier means.
  **Sales Team Alignment** (§14) adopts the same `teamId`/`globalView` prop pattern shipped for
  User Management in v1.318: under the team selector's **All Teams**, the page groups every user
  by their `defaultTeamId` into collapsible Team sections, each further grouped by Subteam, with
  no dead "select a specific team" prompt. A new `GET /api/admin/sales-team-alignment/roster`
  endpoint (scoped via `getAccessibleTeamIds()` plus `loadSubteamAttribution()` — the same
  subteam-resolution helper `dashboards.ts` already uses for Team Activity Deep-Dive itself)
  replaces the old one-call-per-user alignment-count pattern. This surfaced a real RBAC gap: all
  4 backing routes (`GET /sf-users`, `GET`/`PUT /users/:userId/sf-alignment`, plus the new roster
  route) were `requireAppAdmin`-only, which would have silently kept a Team Admin locked out even
  after the UI grew team-scoping — loosened to the router's `requireGlobalAdmin` baseline
  (any admin/team_admin, or app admin) plus a new `canManageUserAlignment(callerUserId,
  targetUserId)` check that verifies the caller and target actually share an accessible team;
  `POST /salesforce/sync-users` (the org-wide SF resync trigger) stays App-Admin-only, and the
  "Refresh from Salesforce" button is hidden client-side for anyone else — the same
  gate-vs-query-scoping distinction called out repeatedly elsewhere in this file (§13 dashboard
  audits, v1.288's security pass).
- **Weekly activity list race condition fixed: another team member's activity could briefly
  appear as the viewer's own (v1.321)** — reported as "a user with no Outlook/Salesforce
  connection somehow has a teammate's synced meeting in their own week." Root cause was in
  `GET /api/activities` (`routes/activities.ts`): with no `userId` query param it fell back to
  returning **every team member's activities for the week, unfiltered by status** (a documented
  but, it turned out, unused "team-wide visibility" branch — its one and only client caller,
  `useActivities.ts`, never actually wants that: it always means to scope to one specific
  person). `WeeklyView.tsx`'s `effectiveViewingUserId` is `currentUser?.id` by default, and
  `useCurrentUser()` resolves asynchronously — so the very first fetch on page load could go out
  with no `userId` at all while that hook was still loading. `useActivities.ts` had no
  request-ordering guard (no abort controller, no "ignore a stale response" check), so if that
  first, unscoped request happened to resolve AFTER a later, correctly-scoped one, its far
  broader result silently won and overwrote the correct state — surfacing a teammate's real,
  already-synced activity (and its hours, inside the viewer's own Weekly Capacity bar) with no
  visible error. Explains every detail of the report: it only ever showed up on the currently
  loaded week (the one live during that race), not on other weeks navigated to afterward (by
  then `userId` was already resolved, so every subsequent request was correctly scoped) — no
  Salesforce/Outlook connection required, since ownership was never actually written to the
  wrong user's row; the DB write was untouched, only the read leaked. Fixed on both sides:
  `useActivities.ts` now waits for a resolved `userId` before firing at all (mirrors its
  existing `teamId` guard — there is no legitimate caller today that wants the unscoped shape),
  and `GET /api/activities` now defaults to the caller's own activities (not "all team,
  unfiltered by status") when no `userId` is given, matching the `/calendar` and `/suggestions`
  siblings, which never had this gap. Also closed a related gap found while fixing the meeting
  owner's email tooltip (§9, v1.319): a legacy activity approved before that column existed has
  a stored owner NAME but a null email, and the edit drawer's live-calendar fallback (§10)
  refused to backfill the email once a name was already stored, to avoid guessing — now it
  backfills specifically when the still-linked calendar event's organizer name matches the
  stored owner name (a real match, not a guess); `ActivityCard.tsx`'s hover tooltip gets the
  identical treatment via a `meetingOwnerEmailOverride` resolved by `WeeklyView.tsx` against the
  same live `weekEvents`, the same pattern already used for the tentative-RSVP hatch (§10).
- **Dashboard page-permission matrix wasn't enforced server-side + fiscal-year config was
  admin-only (v1.322)** — two RBAC gaps, both fitting the "gate says no, matrix/config says yes"
  pattern this file has hit before. (1) Role Management (§14) already lets an admin grant a
  Contributor role visibility into a specific dashboard tab via the `dashboard.<key>`
  page-permission matrix — `Dashboard.tsx` filters its tab list with exactly that check
  (`hasPermission(user, 'dashboard.'+key)`). But every single-team dashboard ROUTE in
  `dashboards.ts` hardcoded `requireRole('leader', 'admin')` at the middleware level, with no
  awareness of the matrix at all — so a Contributor granted a tab this way saw it appear in the
  selector (client-side check passes) and could pick filters, but the actual data request always
  403'd, rendering as an empty "No submitted activities in this range" state. New
  `requireDashboardAccess(dashboardKey)` (`middleware/rbac.ts`) preserves the exact existing
  behavior for leader/team_admin/admin (unchanged fast path), and adds a second path for anyone
  else: does ANY role they hold across ANY team membership have `dashboard.<key>` granted in
  `role_permissions`? — the same union-across-memberships logic `/auth/me` already uses to decide
  tab visibility in the first place, so "the tab shows" and "the data loads" can no longer
  disagree. Swapped into the 21 single-team dashboard routes (§13's Capacity/Activity/Accounts/
  Health/Products/Revenue/Infrastructure/Coverage groups, plus Team Activity Deep-Dive/Won w/o
  POC/Sales Team Breakdown despite living in the Manager group in the UI — those three were
  already single-team-gated with `requireRole`, not the Manager group's `requireAnyLeaderOrAdmin`
  cross-team shape). Left untouched: `/anomalies` (the "What changed" panel embedded in every
  tab, not tied to one dashboard key) and every route already on `requireAnyLeaderOrAdmin`
  (Manager-group cross-team dashboards, History, Most Expensive, User Leaderboard) — those were
  never the reported gap. (2) `GET /api/admin/fiscal-year` — the Fiscal Year Calendar
  Configuration (Admin → Workplace → Calendars, §14) that drives every quarter/year label
  app-wide, including the header's days-left-in-quarter chip (`QuarterCountdown.tsx`) — sat on
  `adminRouter`'s blanket `requireGlobalAdmin` gate like every other admin route, even though
  it's pure read-only display config every signed-in user needs, not an admin screen. A plain
  Contributor's request 401'd, and `useFiscalConfig.ts`'s client-side `res.data ?? DEFAULT`
  silently swallowed that into the hardcoded `{mode: 'calendar', startMonth: 1}` fallback —
  exactly the reported "shows Q3 2026 instead of the configured Q3 FY27" symptom, for literally
  any non-admin/leader user, regardless of Salesforce/Outlook connection state. Fixed by moving
  just this GET registration to before the router's blanket gate, with its own plain
  `requireAuth` — the PATCH (admin-only write) is untouched and still requires `requireAppAdmin`
  explicitly, so only the read got broader, matching the intent that this setting is genuinely
  global and consistent for every user in the system, per its own design.
- **Password reuse/expiry policy + Azure/Entra as a Sign-in Method choice (v1.323)** — see §4 for
  the full write-up. Password-only accounts (`authMethod = 'password'`) can no longer set one of
  their last 5 passwords, and are forced to change it every 90 days via the same
  `mustChangePassword` gate the first-login flow already uses — both entirely exempt for any
  account with Okta or Azure SSO available, since forcing the gate onto an SSO-capable account
  would also block their SSO login (`requireAuth`'s check is unconditional on how the session was
  established). New `password_history` table (migration 0142) and `users.password_changed_at`,
  backfilled to "now" at deploy time rather than `created_at` — there's no real record of a
  password's true age, and backdating would immediately expire long-lived accounts on rollout.
  User Management's Sign-in Method dropdown gains a fourth choice, **Azure/Entra SSO only** —
  Azure SSO login itself already existed (v1.178.0) and worked under any `authMethod` except
  `'password'` even before this, so "Okta SSO only" was quietly already letting Azure through too;
  this pass gives Okta-only and Azure-only genuine mutual exclusivity via shared
  `authMethodAllowsOkta()`/`authMethodAllowsAzure()` helpers, and relabels the `'both'` choice
  (previously "Password or Okta") to **All Login Options** to reflect that it's always included
  Azure once Azure SSO was configured. User Management also gets a Password Reset countdown pill
  (`—` for any non-password-only account).
- **Nudge Rules get an editable Name; Nudge Dismissals merges into Nudge History (v1.324)** — see
  §11/§14 for the full write-up. `nudge_rules.name` (migration 0143, NOT NULL, backfilled to a
  Title Case version of `trigger_type` for every pre-existing rule) lets an admin tell apart rules
  that share the same trigger type, which the rule list, Nudge History, and audit logs now
  identify a rule by. Nudge History moves from App-Admin-only/tenant-wide to team-scoped (like
  every other Nudge Rules screen — App Admins can still switch to **All Teams** for the old
  tenant-wide view), and gains a History/Dismissals tab switcher folding the former standalone
  Nudge Dismissals page in as a second tab (team-only, since Dismissals has no tenant-wide route),
  plus a 4-KPI row (Top Nudge, Top User, Most Snoozed Nudge, Top Snoozing User + avg days snoozed)
  styled like CRM Sync's KPI cards. The existing **Trigger** filter/column is untouched; a new,
  separate **Nudge** filter/column sits alongside it. A migration (0144) flips a stale
  `team_admin`/`admin.nudge_history` = `false` role-permission grant left over from when the page
  really was App-Admin-only (migration 0113) — otherwise the merged page's sidebar entry would
  have stayed invisible to team_admins even after the server-side gate was loosened, the same
  "gate says no, matrix says no too" class of bug this file has hit before, just inverted (usually
  it's the gate that's stale; here the matrix was).
- **Translated the `pt` (Portuguese) share of the untranslated-in-place gap (v1.325)** — same
  pattern as `de`/`fr`/`es`/`ja`. ~125 keys across `admin.*` (fiscal calendar config, activity
  types, approvals, nudge rules), `errors.workweek.*`, `settings.timezone`/`work_week`/
  `worker_type`, `sf_relationship`, and misc dashboard/activity strings held literal English text
  as their stored value; all now hold real Portuguese. Unlike `de`/`fr`/`es` (which keep bare
  `Account`/`Opportunity`/`Lead` as English loanwords app-wide), `pt.json`'s own established
  convention already translates them to `Conta`/`Oportunidade` in dashboard/prose contexts — only
  the `sf.*` namespace (search-tab labels) keeps the English form, matching its own
  `sf.my_filter: "Minhas Opportunities/Accounts"` sibling-key precedent; `Lead`/`Leads` has no
  distinct Portuguese form anywhere in the file and was left as-is throughout. `Status`/`Total`/
  `ACV`/`TCE`/`PTO`/`MFA`/`Slug`/`Heap`/`Endpoint`/`Tokens` follow the file's existing loanword/
  cognate convention (confirmed by grepping existing correct usage before touching anything, not
  guessed) and were left untranslated. A secondary detection pass (English function-word density,
  not just exact-match against current `en`) caught 4 more genuine gaps
  (`sf_relationship.campaign`/`footnote`/`lead`/`opportunity`) whose stored English text had
  fallen out of exact sync with `en`'s own wording after an unrelated copy edit — worth rerunning
  on any future locale pass, since an exact-string diff alone silently misses this class.
  **Process note:** the first translation-application script silently failed to write the file at
  all (an `if errors: ... else: write` branch skipped the write whenever ANY edit in the batch
  didn't match, and 17 of 125 needed a second pass for Unicode-escaping/key-collision reasons) —
  caught only by re-running the detection script afterward and finding the "fixed" keys still
  English. Always re-verify a translation batch by re-scanning for gaps after writing, not by
  trusting the apply script's own reported count.
- **Translated the `it` (Italian) share of the untranslated-in-place gap — the last remaining
  locale (v1.326)** — closes out the i18n defect class opened in v1.312: all 7 locales now hold
  real translations everywhere, not just key parity. ~102 keys across the same `admin.*`/
  `errors.workweek.*`/`settings.*` clusters as every other locale's pass held literal English
  text; fixed using the pt pass's own detection script (exact-match + English-function-word-
  density) verbatim, confirming zero remaining candidates by either method afterward.
  `it.json`'s own conventions turned out to differ from every other locale checked so far, in
  ways only confirmed by grepping existing usage first, not assumed: `Team`/`Manager`/`Email`/
  `Password`/`Account`/`Lead` are ALL kept as established English loanwords (unlike `pt`, which
  translates `Account`→`Conta`), while `Opportunity`/`Opportunities` mostly IS translated to
  `Opportunità` (6 of 7 existing instances) — except where paired directly with `Account` in a
  fixed phrase (`leader.burn.title`/`leader.burn.account`: "Burn Account / Opportunity", a
  genuine deliberate translation that reorders word order but keeps the English object-name
  pair intact) — a real found-in-the-data exception to the dominant rule, not a guess. Similarly,
  `leader.burn_filter.account_rollup` was already correctly translated to `"Clienti (include
  opp.)"` while its siblings `account`/`opportunity`/`all` sat untranslated in the same object —
  the sibling's translation choice (`Clienti`, not `Account`) was followed for those three rather
  than the broader Account-stays-English convention, since it's the more specific, more recent
  precedent for that exact filter dropdown. `Member`/`Members` follow `pt`'s pattern (translated
  to `Membro`/`Membri`) despite `Manager`/`Team` staying English in the same object — confirmed
  before assuming, since a per-locale convention can be internally inconsistent across nearby
  keys and each one needs its own check, not a blanket rule inferred from one sibling.
- **Dedicated rate limiters on OIDC callbacks + Salesforce/History queries (v1.327)** — real
  hardening follow-up on the one item the go-live audit flagged but didn't fix: every route except
  login/MFA/forgot-password/scheduling-refresh/MCP shared only the one generous global limiter
  (600 req/5min per session, admin-configurable, §17). Verified this is genuinely a false-positive
  source for GitHub CodeQL's ~79 "missing rate limiting" alerts across those routers first — the
  global limiter (`index.ts`) is mounted ahead of every router in the real Express middleware
  chain, CodeQL just can't trace a limiter mounted in a different file — before adding anything.
  New `oidcLimiter` (30/15min per IP) on `/auth/okta`, `/auth/callback`, `/auth/azure`,
  `/auth/azure/callback` — the actual pre-login surface, unauthenticated by necessity. New
  router-wide per-user limiters on `salesforceRouter` (60/min — nearly every route here calls
  live Salesforce, a shared metered org-level API budget) and `historyRouter` (30/min — both
  routes can return up to 2,000 rows across multiple DB round-trips with no `team_id` row
  filter). Applied router-wide rather than to individually-picked "expensive" endpoints so a
  future route added to either file inherits the same protection with no extra step — matches
  the existing `requireAuth`-on-the-whole-router convention these files already use.
- **Scheduling → Run Now gives honest feedback on a clock-gated no-op (v1.328)** — reported
  directly: clicking Run Now on `digest_worker`/`weekly_recap_worker` outside their configured
  send window "says it ran now but no update," read by the admin as a broken button. Confirmed
  by code walkthrough this was mostly correct, documented, by-design behavior (§14's Scheduling
  entry already states Run Now deliberately does not bypass the send-window check, and both jobs
  are part of the deliberate "only write a `job_runs` row when real work happened" gate) — but
  the response itself was the real gap: `POST /scheduling/:jobKey/run-now` always returned plain
  success with no way to distinguish "the clock gate correctly declined to send" from "the button
  silently did nothing." Fixed by having the route snapshot the job's latest `job_runs.startedAt`
  immediately before invoking the task and again immediately after, returning `recordedNewRun:
  false` when they're identical (task ran, gate declined) vs. `true` (a real run was recorded) vs.
  a distinct error response. `SchedulingConfig.tsx` renders the false case as a new amber `Clock`
  pill — a third state alongside the existing green-check/red-x — with a tooltip explaining it's
  not the send window yet rather than looking identical to success. New
  `admin.scheduling.run_now_noop` i18n key across all 7 locales. The underlying clock-gating logic
  itself is untouched and correct as designed — this is a feedback fix only, not a bypass.
- **Scheduling: Send Window column + real per-user Run Now countdown (v1.329)** — direct
  follow-up once a user asked whether "send window" in the v1.328 fix meant the same thing as
  cadence. It doesn't — cadence is how often the scheduler ticks, the send window is a separate
  clock-gate check inside `digest_worker`'s/`weekly_recap_worker`'s task body — and that
  conversation surfaced a real design question: the send-window check is evaluated **per-user, in
  each user's own local timezone** (and day-of-week, for weekly recap), so there's no single
  global "next run" instant. Two changes, once that was confirmed: (1) a new **Send Window**
  column shows each job's configured schedule on its own, separated out of the Cadence column
  (which previously showed the actual send time for these two jobs instead of their tick
  interval — itself part of the original confusion); Cadence now uniformly shows just the raw
  tick ("60s tick" / "5min tick") for every job. (2) On a Run Now noop, the route additionally
  computes the real ETA — `getNextDigestEtaMinutes()`/`getNextWeeklyRecapEtaMinutes()`
  (`services/notifications/digest.ts`/`weekly-recap.ts`) scan every enabled user's timezone and
  last-sent timestamp and return the earliest minutes-from-now that any one of them will next
  qualify, deliberately rejected the simpler "countdown against one reference timezone" option
  since that could reach zero while some users' local clocks are past the target and others
  aren't — guaranteeing nothing actually sends at that moment. `SchedulingConfig.tsx` renders
  this as a live countdown ("next possible send in 2h 14m") under the amber noop pill. The pure
  minutes-from-now arithmetic is unit tested independent of the DB query
  (`etaMath.test.ts`) — this is the kind of date-math a hand-check gets subtly wrong (an earlier
  draft of one test's own expected value was off by exactly this trap) that a real test catches
  immediately.
- **KPI rows on Login History, Audit Log, and Scheduling (v1.330)** — the user asked for
  suggestions first, approved all of them, and this ships all 15: 5 per page, styled like CRM
  Sync's bordered stat cards. Deliberately mixed "how much activity" with "what's actually
  wrong" on each page, not just volume counters. **Login History**: Failed Login Rate, Suspicious
  Logins (with an "alert not sent" sub-count), Top Failure Reason, SSO vs. Password split, and
  Accounts Under Attack (3+ failed attempts on one account in 24h) — all computed client-side
  from the same capped recent-events fetch (bumped 200→500, matching CRM Sync's own limit).
  Building the SSO-split KPI surfaced a real correctness trap worth remembering: MFA is required
  on every password login (§4), so a successful password-path sign-in is never actually tagged
  `method: 'password'` — only failed attempts are, before MFA runs. The KPI checks membership in
  the SSO method set rather than `!== 'password'`, which would have silently always read "100%
  SSO." **Audit Log**: Total Events, Destructive Actions, Most Active Admin, and Distinct Actors
  (all a 7-day window) plus an all-time Retention Horizon against the configured
  `AUDIT_EVENTS_RETENTION_DAYS` — these needed a new dedicated `GET /admin/audit/summary` route
  with real aggregate queries, since the page's own list is capped at 100-200 rows and would
  silently undercount a real weekly figure. "Destructive" is a curated allowlist
  (`DESTRUCTIVE_AUDIT_ACTIONS`, `src/shared/auditActions.ts`), not a suffix heuristic — a
  heuristic on the word "delete" would misclassify `activity.outlook_deleted.keep` (the
  non-destructive KEEP branch) and flag `work_week.reject` (a workflow decision, not data loss).
  **Scheduling**: Jobs in Error, Jobs Disabled, Never Run, No Error-Alert Configured, and Failed
  Runs (7d) — the first four read straight off the existing registry/latest/config payload
  already on the page; the fifth needed one new `count(*)` query, since the existing `recent`
  list (20 rows total across every job) isn't a reliable sample for a weekly figure. All 24 new
  i18n keys translated in all 7 locales, not left on the English-defaultValue fallback.
- **My Settings groups collapsible + Admin background watermark seam fixed (v1.331)** — two
  small UI-polish requests. (1) My Settings' five top-level groups (Connections, Preferences,
  Data & Templates, Security & Access, Work & Notifications) are now individually collapsible —
  only Connections open by default, since the others are read occasionally rather than on every
  visit — plus a single expand/collapse-all icon button in the page header (reuses the existing
  `activity.expand_all`/`collapse_all` i18n keys, already shared across the Activities page and
  My Notes rather than introducing a settings-scoped duplicate). Per-group open state is a plain
  keyed boolean record in `Settings.tsx` (only 5 fixed groups — simpler and more accurate than
  the tick-propagation pattern `SectionAccordion`/`ChevronsDownUp`/`ChevronsUpDown` use elsewhere
  for open-ended lists, since a fixed set can just derive "all open" directly from real state
  instead of tracking it separately). (2) The Admin pages' world-map watermark
  (`Admin.tsx`, `/world.webp`) is a fixed-aspect raster — deliberately sized off the container's
  height only (`auto 115%`) and pinned to the right edge, since scaling it to the container's
  full width would stretch and warp the globe/rings artwork. On a wide browser window the image
  simply stopped covering the left portion of the page, and since that div had no
  `backgroundColor` of its own, the gap showed the raw page background with zero wash — a seam
  that grew with the window. Added a `backgroundColor` (a flat fill, unlike the raster image,
  trivially covers `inset-0` at any width) approximating the image's own outermost ring tone, so
  the two meet without a hard edge — the globe artwork itself is completely untouched. Verified
  by TypeScript compile + the full test suite only — a full local Postgres run hit an unrelated,
  pre-existing migration-tooling issue (a same-transaction `ALTER TYPE ... ADD VALUE` + use,
  which Postgres disallows before commit) when applying the entire migration history from an
  empty database via `drizzle-kit migrate` in this sandbox, so the visual result itself was not
  screenshot-verified in a live browser — and that gap showed: the `backgroundColor` patch was
  wrong. *(v1.331.1)* It painted the WHOLE div uniformly, not just the gap the image doesn't
  reach — since it sits behind the image and both get the same `mix-blend`/`opacity` treatment,
  the area the image already covers got the flat color stacked on top of it too, reading as "the
  whole page went gray" rather than a closed seam, exactly as reported with real screenshots this
  time. Replaced with `background-size: cover` and no color at all: `cover` scales the image by
  the *same* factor in both dimensions (so, unlike a plain width/height stretch, it mathematically
  cannot warp or distort it — only crop the overflow) and by definition always fully covers the
  container at any size, making a fallback fill unnecessary. This is the actual right tool for
  "always fill the box without distorting the art" — reach for it before a synthetic color patch
  next time this pattern comes up.
- **App Updates, Phase 1: read-only self-update check (v1.332.0)** — see §14b for the full
  writeup. Investigated and scoped across two prior rounds (a written research pass with no code,
  then a clarification round) before this build: App Admins get a sidebar Update pill and a
  version-chip dot when a newer version exists on the pinned `main` branch, with a modal showing
  what changed; only the app's one designated default admin (`users.is_default_admin` — a
  pre-existing singleton, confirmed reusable rather than inventing a new flag) can configure the
  GitHub PAT/repo or trigger a live check, everyone else App-Admin-and-up can only view. Built
  deliberately host-independent (no Dokploy assumption — the user explicitly corrected an earlier
  draft that assumed it) by comparing `APP_VERSION` against the pinned branch's own
  `CHANGELOG[0].version`, fetched via the plain GitHub Contents API and parsed with a new
  hand-written safe parser (`parseChangelog.ts` — never `eval`s fetched source) rather than
  needing any CI/build-time version injection. `APP_VERSION` itself moved to
  `src/shared/appVersion.ts` so the server could import the identical constant. No schema
  migration needed — reuses the existing generic `system_settings` table, the same pattern as
  Slack's bot-token storage. New `requireDefaultAdmin` middleware (mirrors `requireAppAdmin`).
  **Phase 2 (triggering an actual redeploy, the in-app restart countdown) is explicitly deferred**
  — this round stops at "check + inform," per the original scoping.
- **App Updates, Phase 2: scheduled maintenance window + self-restart (v1.333.0)** — see §14b's
  new Phase 2 section for the full writeup. Before building, the user asked the one question that
  had to be answered first: after installing an update, does the app actually restart the server
  to put it in place? The honest answer — researched and explained before any code was written —
  is no, and can't, while staying host-independent: what's running is a compiled image, GitHub
  being ahead of `APP_VERSION` says nothing about what's loaded in memory, and actually rebuilding
  and swapping the running container from inside the app would need either Docker-socket access
  (a real privilege-escalation surface) or a specific host's API (reintroducing exactly the
  Dokploy assumption Phase 1 was built to avoid). Presented as two options — comms only with a
  manual restart, or comms plus the app self-restarting its own process at the scheduled moment
  (useful only if the admin has already staged a rebuilt image out-of-band beforehand) — the user
  picked the second. Built: the default admin schedules a restart (date/time + optional message)
  from a second section on the same Admin → Integrations → App Updates card; every signed-in user
  sees an advance-notice banner (dismissible, mirrors `connections-banner.tsx`'s Outlook/SF
  reminder pattern) that becomes a non-dismissible live 30-minute countdown, then a dismissible
  post-restart confirmation. A new 15s-tick `restart_scheduler` job fires the actual
  `process.exit(0)` at the scheduled instant, relying on `docker-compose.yml`'s existing
  `restart: unless-stopped` policy to bring the container back up — verified that policy was
  already in place before relying on it. New `logSystemAudit()` helper
  (`services/audit/log.ts`) audits the restart-scheduler job's own action, since a background job
  has no `Request` to derive an actor from the way every other audited action does. No schema
  migration needed — a second `system_settings` key (`maintenance_window`) alongside Phase 1's.
  Automatically triggering the actual redeploy itself remains explicitly out of scope — see
  Deferred/Roadmap.
- **Changelog popover simplification, Marketing Event Name, required-field markers (v1.334.0)**
  — three small, independent UI requests from the same round of feedback. (1) The sidebar
  version-chip's changelog popover collapsed everything past the top 2 releases into two
  separate sections — a detailed "Earlier releases" (next 8) and a terse "Older releases"
  (everything else) — which read as confusingly similar once the list grew past a few hundred
  entries. Merged into a single "Earlier releases" collapsible covering everything past the
  top 2, in the same detailed (version/date/full highlights) format the old "Earlier" section
  used; the now-dead `changelog.older_releases` i18n key was removed from all 7 locales rather
  than left stale. (2) See §7's new "Marketing Event Name capture" note — an optional free-text
  field on the Log Activity form, shown only when the chosen type is named "Marketing" (same
  name-matched, ImpactIQ-only convention as "Why Meeting?"), with an example placeholder.
  New `activities.marketing_event_name` column (migration 0145). (3) The Log/Edit Activity
  drawer's five schema-required fields (Title, Activity Type, Start Time, End Time, Effort
  Hours — confirmed from `CreateActivitySchema` in `src/shared/schemas/index.ts`, not guessed)
  now show a red `*` next to their label, plus a one-line legend at the top of the drawer
  explaining the convention. End Time and Effort Hours also gained the native HTML `required`
  attribute on their `<input>`, matching Title/Start Time, which already had it — a pre-existing
  inconsistency fixed while in the area.
- **App Updates post-restart resync, changelog trim, Outlook-locked datetimes, End-before-Start
  fix, Products/Subtype required (v1.335.0)** — a batch of small fixes and one investigation from
  the same round of admin feedback. (1) `checkForUpdates.ts`'s scheduled job now runs its first
  tick 10s after boot instead of waiting the full 6h interval — since the worker starts
  unconditionally on every server start (`index.ts`), this is what makes the cached
  `github_update_status` row self-correct promptly after ANY restart, including the one
  `restartScheduler.ts` (§14b Phase 2) triggers — without it, a real out-of-band deploy could sit
  for up to 6h still showing the previous process's stale "update available" banner. (2) The
  sidebar changelog popover's "Earlier releases" list is capped at the next 25 entries past the
  top 2, instead of the entire remaining history (417 entries and growing) — `nav.tsx`'s
  `CHANGELOG.slice(2, 27)`. (3) An activity linked to an existing Outlook meeting
  (`form.outlookEventId` set) now grays out Start Time, End Time, and Effort Hours in the
  Log/Edit Activity drawer — the calendar event is the source of truth for when the meeting
  actually happened, so a hand-edit that would silently drift from the real meeting is blocked;
  a manually-created activity (no linked Outlook event) keeps these fully editable, same as
  before. New `isOutlookLinked`/`datetimeLocked` derived flags in `ActivityForm.tsx`, plus a
  `outlook_locked_hint` hint under Effort Hours. (4) Fixed a real bug found via live
  reproduction (a local Postgres + browser session, not just code reading): editing End Time to
  land at or before Start Time silently produced a real, savable "0.0h" activity via
  `computeEffortHours()`'s negative-duration clamp, with zero visual indication anything was
  wrong — exactly the "meeting time change zeroes out effort hours" symptom reported. Fixed with
  a new `endBeforeStart` derived flag: a red border + inline error under End Time
  ("End time must be after start time"), and Save Draft/Submit both disabled with a matching
  tooltip until the range is valid — enforced both in the button `disabled` prop and as a
  belt-and-suspenders guard inside `handleSave()` itself (reachable via Enter-key submission,
  which doesn't go through the button). Deliberately does NOT auto-shift Start when End is
  edited — that would break the existing, correct "resize from Start" semantics for every VALID
  End edit, just to paper over the invalid ones. (5) Products and Subtype are now both
  independently required on the Log/Edit Activity drawer (red `*`, red border, inline error,
  Save/Submit blocked) — but ONLY when the field is actually reachable: a team with zero
  configured Products, or with `subtypesEnabled` off (or the current Activity Type having no
  Subtypes at all — §7's `showSubtypePicker` gate), renders no picker at all, so requiring it
  unconditionally would have permanently blocked Save/Submit for every activity on that team
  with nothing the user could ever select to satisfy it. `productsRequired`/`subtypeRequired`
  mirror the picker's own existing visibility conditions exactly, not a new independent check.
- **Outlook own-copy title write-back, Attendees remove-chips, Restart Now (v1.336.0)** — direct
  follow-ups once the two v1.335.0 research questions got real answers. (1) The admin tested the
  Outlook title-write-back question live against a real tenant rather than taking the "needs
  live-tenant verification" caveat at face value: as a non-organizer attendee, editing a meeting's
  subject directly in Outlook DID save — but only on their own calendar, never propagating to the
  organizer or other attendees. That's the exact same mailbox-local-write shape `categories`
  already has (§10, `ensureEventCategorized()`, v1.244) — a per-mailbox PATCH that touches only the
  caller's own copy and sends no update to anyone else. New `ensureEventTitleSynced()`
  (`services/outlook/client.ts`) mirrors that function's shape: GETs the event's current `subject`
  first and skips the write when it already matches (avoids a Graph PATCH on every edit-save where
  the title didn't change), otherwise PATCHes `subject` on the caller's own calendar. Wired into
  the same three call sites `ensureEventCategorized()` already fires from — activity create,
  activity update, and the owner-triggered resync route (`routes/activities.ts`) — renamed from
  `maybeCategorizeOutlookEvent` to `maybeSyncOutlookEvent` since it now does both. Same
  `outlookWritebackEnabled` opt-in gate, same submitted-only / `outlookEventId`-only scope, same
  fire-and-forget-and-log-only-on-failure contract. Skipped for a Private/Confidential meeting
  (`isPrivateMeeting`) as an extra guard — `activities.title` already holds the real subject even
  when the UI substitutes "Private meeting" for display (§7), so there's technically nothing to
  leak, but a contributor-edited Title on a flagged-private meeting doesn't get pushed to Outlook
  regardless. (2) The Attendees free-text textarea (§9-adjacent, `ActivityForm.tsx`) now renders a
  chip row above itself — one pill per parsed attendee, a red `CircleMinus` button on the left of
  each name — reusing the existing `serializeAttendees()`/`parseAttendees()` round-trip with no new
  parsing path: clicking a chip's remove button filters that one entry out of `form.attendees` and
  re-serializes the result back into the same textarea state the typed-name flow already writes to.
  The textarea itself is untouched — typing new names in still works exactly as before. (3) A
  **Restart Now** button next to Schedule/Update schedule on Admin → Integrations → App Updates'
  Scheduled Maintenance section, answering "is there really no way to force a restart, only a
  future-scheduled one?" No new backend route: it calls the exact same `PUT /maintenance-window`
  the scheduler form uses, just with `scheduledAt` ~15 seconds out instead of an admin-picked
  future time, so `restart_scheduler.ts`'s existing 15s tick catches it on its very next pass.
  Still carries the identical default-admin-only gate, confirm dialog, and audit action as the
  scheduled path, and the same "not a deploy" caveat (§14b) applies — restated in the confirm
  dialog and a persistent hint under the button, since skipping the announcement window makes it
  easier to fire without reading the caveat first. Deliberately does NOT build the actual
  auto-redeploy (pulling/rebuilding code) — see Deferred/Roadmap, unchanged from v1.333.0's own
  scoping: that's a real privilege-escalation/host-assumption tradeoff needing its own explicit
  sign-off, not something a "can we force a restart" follow-up unlocks on its own.
- **Support Ticket attachment (v1.337.0)** — see §7's new "Support Ticket attachment" note and
  §14's Activity Types bullet. A new `ticket_picker` kind on the existing per-Activity-Type SF
  Extras mechanism lets an admin turn on multi-ticket attachment for any Activity Type (Support
  being the first, but not hardcoded to that name) — a contributor searches Salesforce tickets
  connected to the activity's linked Account by default, with Open Search always available as a
  toggle to search outside it, attaches as many as needed, and the ticket number links straight
  out to Salesforce in a new tab. Built from three decisions the admin locked in up front, all
  matching CLAUDE.md's existing conventions rather than inventing new ones: (1) configurable per
  Activity Type via the Extras mechanism, not hardcoded to one type's name; (2) ImpactIQ-only
  storage with a read-only link-out — new `activity_sf_tickets` table (migration 0146), never
  read by `buildSfRecord()`, same "never part of the SF payload" contract as Subtypes and
  Marketing Event Name; (3) every display field (Ticket Number, Subject, Date Opened, Status,
  Contact, plus Description/Platform/Owner shown on hover) resolved via new `ticket_*` app fields
  in SF Field Mappings, following the Evaluation ("Project") field convention (§9) rather than
  `related_object_picker`'s convention of typing field names into the Extra's own config — the
  admin's own request, since the ticket picker needs far more display fields than any existing
  related-object picker ever did. `GET /api/salesforce/tickets/search` resolves the mapped fields
  live per request (its own 1-hour describe cache, kept separate from the Evaluation block's own
  cache per this file's "no shared cache across features" convention) using the calling user's
  own SF connection. Closed tickets are hidden by default — the admin picks which live Status
  picklist values count as "closed" (fetched via the existing `GET /api/admin/sf/fields?object=`
  describe endpoint once `ticket_status` is mapped), stored on the Extra's own config alongside
  `sobject` and an optional display `label`; a Show Closed checkbox reveals them, same convention
  as Salesforce Link's own Show Closed toggle (§7 v1.272). Known v1 gap, left for a future pass
  same as Project's Primary Engineer originally was: Contact/Owner are read as plain SELECT
  values with no automatic Id-to-name resolution if either happens to be a User lookup rather
  than a picklist/text field on a given org.
- **Support Ticket follow-ups: form placement, Validate & Dry Run auto-detection, Sample
  record (v1.338.0)** — three direct fixes/asks from live-testing the v1.337.0 feature. (1) The
  Support Tickets picker moved from down by the Salesforce Link section to directly under
  Activity Type/Subtype and Start/End Time — see §7's new "Form placement" note. `SfExtrasPanel`
  split into itself (Opportunity-gated kinds, unchanged) plus a new `TicketExtrasPanel` (ticket
  picker only, mounted higher up), sharing one `useActivityTypeSfExtras()` fetch hook so the
  split doesn't double the `GET /api/activities/sf-extras/:typeId` calls. (2) Validate & Dry
  Run's object scope (§9) only ever covered Event/Task plus any object with a WRITE-capable
  mapping — an object whose mappings are ALL `direction: 'read'`, like the Ticket picker's own
  `ticket_*` fields, simply never appeared on the page at all, with no error or indication
  anything was skipped; reported as "I added Ticket/Case and it isn't showing, and I shouldn't
  have to tell it each time." Fixed with a third scope tier (any object with ≥1 active mapping
  of any direction, not already covered) getting the same static + describe checks; also added
  `KNOWN_READ_APP_FIELDS` (mirroring `OTHER_WRITE_APP_FIELDS`'s pattern but for reads) so the
  new `ticket_*` fields don't falsely show as `unknown_app_field` despite being genuinely read
  by `GET /api/salesforce/tickets/search`. (3) A new **Sample record** button per object
  (`GET .../sf-field-mappings/sample?sobject=`) — a live "pull one real record and show what
  each mapped field resolves to" table, deliberately a separate on-demand fetch from Run Check
  itself so it never slows down the automatic check. Requested directly: "I want it to pull a
  random record and show data for that object... is there a way to run a quick test on a
  specific SF object." Reuses `resolveFieldPath()` (`refreshOppSnapshots.ts`) so a
  relationship-path mapping (`Owner.Name`) resolves its nested value correctly.
- **Ticket Owner/Contact User-lookup resolution + a second placement move (v1.339.0)** — two
  more direct fixes from continued live-testing. (1) The v1.338.0 Sample record button
  (previous bullet) is what surfaced this: `ticket_owner` mapped to `Case.OwnerId` showed the
  raw Salesforce Id (`00G4u000004dLngEAE`) instead of a name. `OwnerId` is a genuine
  `Lookup(User)` — the identical field-shape ambiguity `eval_primary_engineer` already solved
  for (§9, v1.285–286) — so the fix is the same one: resolve via `resolveUserLookupNames()`
  against the local `sf_users` cache whenever the mapping's `reference_to` is `'User'`, rather
  than assuming every ticket field is a flat text/picklist value. Wired into both call sites
  that read ticket fields — `GET /api/salesforce/tickets/search` (the contributor-facing picker)
  and `sampleObjectRecord()` (the admin's Sample record preview, §9) — generalized to whichever
  of `ticket_contact`/`ticket_owner` actually resolves to a User lookup on a given org, not
  hardcoded to `ticket_owner` alone, since Contact can be a User lookup too on some orgs. (2)
  Direct follow-up feedback on v1.338's placement fix: "between the Activity Type row and the
  Start/End time row" — moved one step earlier than v1.338 landed it, from just after
  Start/End Time to just after the Activity Type/Subtype row, so it appears the instant a type
  with a `ticket_picker` Extra configured is chosen (see §7's updated Form placement note).
- **Ticket Owner polymorphic User/Group resolution (v1.340.0)** — v1.339's fix assumed
  `ticket_owner` is always a `Lookup(User)`; live testing showed the real example id
  (`00G4u000004dLngEAE`) was a Group/Queue id the whole time, which the `reference_to ===
  'User'`-gated resolver silently skipped — `Case.OwnerId` (and any Owner-shaped field) is
  POLYMORPHIC, since a ticket's owner genuinely flips between a person and a queue over its
  lifecycle, and the admin UI's auto-capture only ever stores ONE of the two `referenceTo`
  target types describe() reports. New `resolveOwnerLookupNames()` (`resolveLookupNames.ts`)
  tries the local `sf_users` cache first, then falls back to a single live SOQL query against
  `Group` (Queues are stored as `Group` records with `Type='Queue'`) for whatever's left
  unresolved — deliberately no new local Group/Queue cache table, since queues are far less
  numerous and change far less often than users, so a live round-trip per distinct owner id
  per request is cheap here in a way it wouldn't be for users. The gating condition also
  widened from an exact `'User'` match to any truthy `reference_to`, so resolution fires
  regardless of which of the two polymorphic target types got captured. Wired into both
  `GET /api/salesforce/tickets/search` and `sampleObjectRecord()`, same call sites v1.339
  touched.
- **Ticket data drawer-open background refresh (v1.341.0)** — direct follow-up once the
  v1.340.0 fix was confirmed working: an admin reported Ticket Owner now resolving correctly
  "on a fresh refresh of the record," but an already-attached ticket (attached before that fix
  shipped) still showed the stale snapshot value, since nothing had ever re-read it. Asked
  first, before writing any code, how often this should refresh and what the performance/SF-API
  tradeoff should look like (discussion-only turn, no changes) — landed on: refresh on drawer
  open, not a nightly batch job (no other consumer needs the fresher data yet) and not folded
  into the existing blocking hydration fetch, per explicit direction to never delay the
  drawer's own open. Built as a second, independent, non-blocking fetch
  (`GET /api/salesforce/tickets/refresh?activityId=`, `routes/salesforce.ts`) fired right after
  the hydration effect populates `tickets` — one batched `WHERE Id IN (...)` SOQL query
  (never one round-trip per ticket) against the calling user's own SF connection, reusing the
  `/tickets/search` route's own describe-filtering/field-extraction/lookup-name-resolution logic
  (newly factored into `buildTicketSelectPairs()`/`filterTicketSelectPairsByDescribe()`/
  `extractTicketFields()`/`resolveTicketLookupNames()` so the two routes can't drift), persisting
  the refreshed values back onto `activity_sf_tickets` and returning them. Degrades to the
  unchanged stored snapshot at every failure point (not SF-connected, no `ticket_picker` Extra
  configured, query failure, etc.) — same contract as the rest of the feature. `ActivityForm.tsx`
  tracks this in a separate `ticketsRefreshing` boolean that never gates the drawer's render,
  showing a small spinner (`Loader2`, `animate-spin` — the same spinner convention already used
  elsewhere, e.g. `sf-connect-button.tsx`) next to the Support Tickets label while the background
  call is in flight, then merges the fresh field values into `tickets` state by `sfTicketId` on
  response. See §7's new "Drawer-open background refresh" bullet for the full write-up.
- **Ticket right rail + Weekly Capacity filter reset (v1.342.0)** — two independent requests
  from the same round of screenshots. (1) The activities list gave no visual signal that an
  approved card had Support Tickets attached, so a leader/contributor had to open the drawer to
  find out — see §7's new "Card indicator: flush right rail" bullet. `GET /api/activities`'s list
  route now batch-counts `activity_sf_tickets` per activity the same way it already does for
  `notesCount`, and `ActivityCard.tsx` renders a full-height red rail flush on the card's right
  edge when `ticketCount > 0` on a submitted activity, mirroring the left type-color bar's own
  convention but on the opposite edge so the two never compete for space. (2) Clicking a Weekly
  Capacity legend chip (e.g. "Eval Work") to filter the day list down to one activity type kept
  that filter applied after navigating to a different week — the capacity bar itself correctly
  showed the new week's real per-type totals, but the day list silently kept filtering by the
  stale type id, and the "Showing X activities only" banner's own name lookup
  (`activities.find(a => a.activityTypeId === typeFilterId)`) fell back to `null` the moment the
  new week had no matching activity, so the banner disappeared too — leaving an unfiltered-looking
  week that actually showed 0 activities every day with no explanation. Fixed with a `useEffect`
  that resets `typeFilterId` to `null` on every week change. **First attempt at this fix shipped a
  real bug of its own, caught only by testing it live in a browser**: keying the effect on
  `weekStart` (a `Date` object `useActivities.ts` recomputes via `startOfWeek(addWeeks(new Date(),
  weekOffset), ...)` — a brand-new object identity on every render, even when the value is
  unchanged) fired the reset on every render, not just real navigation, so the filter chip visibly
  did nothing when clicked — it was set and then immediately unset before the next paint. Fixed by
  keying on `weekOffset` instead, the primitive number `useActivities` already exposes, which only
  changes on an actual week navigation. **Lesson: a `Date`/object value from a hook is not a safe
  `useEffect` dependency unless the hook itself memoizes it — a primitive proxy for "did this
  actually change" (an offset, an ISO string, a timestamp number) is required instead**, the same
  class of trap `useCallback`/`useMemo` dependency arrays hit with non-primitive values generally.
- **CodeQL type-confusion fix on ticket search (v1.342.1)** — GitHub Advanced Security flagged
  `GET /api/salesforce/tickets/search`'s `q`/`accountId` query-param handling as "type confusion
  through parameter tampering": both were read via an unchecked `req.query['x'] as string |
  undefined` cast, which is a compile-time-only assertion — Express actually types a query param as
  `string | ParsedQs | (string | ParsedQs)[] | undefined`, so a request like `?q=a&q=b` hands the
  route a real array at runtime despite the cast. Both values flow into `safeSoqlLiteral()`, which
  assumes a string and calls `.replace()` on it — a non-string value there either throws or, if the
  runtime coerces it via `Array.prototype.toString()` first, stringifies in a way the escaping was
  never designed to see. Fixed by switching both to the `typeof x === 'string' ? x : undefined`
  runtime guard already used consistently by every other query-param read in this exact file (15+
  call sites) — this route's `as string | undefined` cast was the one place that had drifted from
  that established convention. `teamId`/`sobject` were left as-is: `sobject` is separately validated
  against `SOBJECT_RX` before use (a non-string coerces to a comma-joined string via `RegExp.test`'s
  own `ToString`, which fails that regex safely), and `teamId` only ever reaches a parameterized
  Drizzle query, never a hand-built SOQL string.
- **Scheduling Free Time panel: PTO toggle (v1.343.0)** — the Scheduling page's Free Time card
  (`FreeTimePanel.tsx`) already had a Common/Per User toggle (who's free when, together vs.
  broken out per person); this adds a third **PTO** toggle in the same small pill-button group
  (`Palmtree` icon — reused from the existing PTO button on the Weekly View day rows, per §19c's
  "search for an existing pairing before inventing a new one" convention, rather than the more
  generic `TreePalm` alias). Selecting it lists, per day, just the team members who actually have
  PTO that day (name + amber "PTO" label) — days with nobody out are skipped entirely, same
  "only render what's there" convention Common mode already uses for its own empty slots. No new
  data source: `SchedUser.pto` (a `string[]` of `yyyy-MM-dd` dates, already fetched for the
  existing Common/Per-User modes' PTO-day exclusion) is simply filtered and re-rendered under the
  new mode — `user_pto_days` needed no changes.
- **Activities Disconnected from SF (v1.344.0)** — see §7/§13 for the full write-up. Salesforce
  records an activity links to can be deleted after the fact, and until this feature nothing in
  the app ever detected it — a stale What/Who/Related link just sat there silently forever.
  Requested as: a new leader dashboard listing the affected activities, powered by a nightly
  background job (not a live per-view check, so it loads fast for every viewer); independently,
  a live check when a specific activity's edit drawer is opened; and a badge on the activity card
  in the Weekly View. Three new `activities` columns (`sfWhatDeleted`/`sfWhoDeleted`/
  `sfRelatedDeleted`, plus `sfDisconnectCheckedAt`) are set by two self-healing mechanisms — the
  nightly `detect_disconnected_links` job and the drawer's own live check — both built on a new
  `checkSfRecordsExist()` (`referenceResolver.ts`), a sibling to the pre-existing
  `resolveSfReferences()` with a deliberately stricter contract: the existing function collapses
  a thrown query error into the same result a genuine "not found" produces (fine for its
  original display-name-lookup purpose, unsafe for deletion-flagging), so the new function lets
  a query exception propagate instead, and every caller treats a thrown error as "check failed,
  leave existing state alone" — never as "confirmed deleted," matching the "absent from a failed
  fetch is not the same as deleted" precedent Deleted Outlook Activities (§10) already
  established. The nightly job isolates failures per `(linkField, objectType, chunk)` rather than
  one big try/catch, since a single run scans every team's every object type and one
  misconfigured Related-object string (Related is per-team admin-configured free text) must
  never blank everyone else's results.
- **Opportunity Relink + Closed Lost — Needs Review (v1.345.0)** — see §7/§13 for the full
  write-up. Requested to address a different, adjacent problem from Activities Disconnected
  from SF above: a rep closes an Opportunity Lost/Duplicate (often because the deal moved to
  a renewal or was split into a different Opportunity) while the real, ongoing/won work
  continues under a DIFFERENT live Opportunity — every ImpactIQ activity still linked to the
  dead one reads as lost forever, with nothing in the schema or SF mappings to trace the
  real replacement. Presented the user 3 design options up front (per explicit request,
  before any code); the user chose to build both a manual Relink action AND a proactive
  review queue, scoped to App Admin + Team Admin + Team Leader, all-time/ImpactIQ-only in
  scope, and confirmed a relink must also push the corrected link to Salesforce. The
  Salesforce write-back turned out to need zero new SF-calling code once `writeback.ts` was
  read directly: `buildSfRecord()` already reads `activity.sfWhatId` fresh at sync time and
  picks create-vs-update purely off whether `sfRecordId` is already set, so re-queuing
  `sfSyncStatus = 'pending'` on an already-synced row is the entire "push to Salesforce"
  mechanism — the existing async poller does the rest, correctly hitting the pre-existing
  Event/Task's update path rather than creating a duplicate. New `opp_review_dismissals`
  table (migration 0148) backs the dashboard's permanent Dismiss/Undismiss. Both new pieces
  of DB logic (`applyOpportunityRelink()`, `fetchClosedLostReviewCandidates()`) were
  extracted out of their route handlers into standalone functions specifically to make them
  independently testable against pglite, following the `buildSfRecord()`/`validateOne()`
  convention already established in this codebase — new `relinkOpportunity.test.ts` (9
  tests: the pure snapshot-patch builder, plus draft+submitted scope, the `sfRecordId`
  re-queue gate, the `sfWhatDeleted` reset, and team-scoping) and `closedLostReview.test.ts`
  (6 tests: closed/won inclusion logic, draft exclusion, dismissal exclude/include, team
  scoping) both pass, alongside the full 140-test suite and a clean i18n parity check.
  **Process note**: a Plan agent launched with an isolated git worktree to draft this design
  reported that `activities.sfWhatDeleted` and `checkSfRecordsExist()` "don't exist" — false
  for the actual working branch, whose worktree snapshot predated this same session's
  Activities Disconnected from SF work landing. Caught by independently verifying every
  claim against the real repo state (`git log`, `grep`) before finalizing the plan, rather
  than trusting the agent's findings at face value — a worktree-isolated subagent's account
  of "what exists in the codebase" is only as current as the ref it was handed, and needs the
  same skepticism as any other unverified claim about the codebase.
- **Team theme dropdown fix + single-button SSO login (v1.346.0)** — two independent
  small requests from the same round of admin feedback. (1) Admin → Team Management's
  per-team Theme dropdown (`TeamThemePicker`, `TeamsConfig.tsx`) already correctly named the
  current org-default theme on its OWN row (driven live by that theme's `isActive` flag), but
  the dropdown's separate "— Inherit org default —" PLACEHOLDER option was a static string
  that never referenced which theme is actually active — so switching the org default via
  Admin → Themes → Set as Default never visibly changed it. Fixed to interpolate the live
  default theme's name (`"— Inherit org default (Acme Brand) —"`), and relabeled the
  per-theme-row suffix from `"(org default)"` to `"(Default)"` to match the wording the Themes
  admin page itself already uses. (2) The Login page's two separate "Sign in with Okta" /
  "Sign in with Microsoft" buttons (§4) are now ONE button — a new `SsoSignIn` component in
  `Login.tsx`. With only one provider configured (the common case — `oktaConfigured`/
  `azureConfigured` are independent org-wide flags from `GET /auth/{okta,azure}/configured`,
  unrelated to a specific user's `authMethod`) there's nothing to choose, so it's already a
  single button, generically labeled "Sign in with Identity Provider," and clicking it goes
  straight through. With both configured, clicking it opens a small inline picker (in normal
  document flow, not absolutely positioned — an early version floated it over the "Or with
  email" divider and obscured it, caught by actually running the app and screenshotting it,
  not just reading the diff) offering "Continue with Okta" / "Continue with Microsoft" plus a
  "Remember my choice on this device" checkbox (on by default, unchecking it just means the
  picker reappears next visit). A remembered choice is a plain `localStorage` key
  (`impactiq_sso_provider`) — pre-auth, so there's no session to key it off of, same
  device-local-only convention `LanguagePicker` already uses on this exact page — and shows as
  a specific "Sign in with Okta"/"Sign in with Microsoft" button plus a small "Switch" link
  that clears the stored choice and reverts to the generic picker. Verified end-to-end by
  actually running the real Vite dev server against a stubbed backend (`/health`, `/auth/me`,
  `/auth/{okta,azure}/configured`) and driving it with Playwright through all four states
  (single-provider, picker-open, remembered-choice, post-Switch) — not just `tsc`/unit tests,
  since this is pure client UI/UX with no server-side logic to unit test.
- **Themes: palette retired, promoted to a real theme (v1.347.0)** — direct follow-up on the
  v1.346.0 dropdown fix, once the admin pointed out the deeper issue it was papering over: Admin
  → Team Management's Theme dropdown showed only 2 of the 3 things visible on Admin → Themes,
  because the "Acme Brand Palette" shown at the top of that page was never a real, assignable
  `app_themes` row — it was a separate `system_settings`-based singleton (3 keys: colors, logos,
  email config) with no `id`, so it structurally could never be a `teams.active_theme_id` target.
  The user's own hypothesis (duplicate IDs from a clone) was investigated and ruled out —
  `POST /themes/:id/clone` always mints a fresh UUID via Drizzle's schema default, so no collision
  was possible — the real cause was architectural, and the user's explicit direction was to
  "upgrade the system" rather than patch the symptom: retire the palette entirely and make
  everything a uniform, real Theme. See §14's new Themes write-up for the resulting architecture.
  Migration `0149_promote_palette_to_theme.sql` is a pure-data, `WHERE NOT EXISTS`-guarded
  backfill (no DDL) — verified via 3 pglite-backed tests, including one that re-executes the raw
  migration SQL against an already-migrated instance to directly prove idempotency, and one that
  mirrors the real reporting org's actual data shape (Channel + Acme Brand already existing)
  to prove the migration is a safe no-op for them specifically. `GET/PUT /themes/palette` and
  `POST /themes/deactivate-all` are removed outright — the latter's own code comment had literally
  spelled out the design flaw it existed to work around ("the palette isn't in app_themes, so
  activating it means turning off all themes"). New server-side guards close the resulting "can
  the app ever end up with zero themes" question for good: `PATCH /themes/:id` now rejects
  `isActive: false` outright (the only way to change which theme is active is activating a
  *different* one), and `DELETE /themes/:id` rejects deleting the last remaining theme or the
  currently-active one. `ThemingConfig.tsx` loses its entire separate "palette" card and its own
  parallel set of handlers (~230 lines); a genuine pre-existing bug was found and fixed in the
  same pass while wiring the new DELETE guard's error through — `formError` state existed and was
  set on failure, but was never actually rendered anywhere in the component's JSX, so a rejected
  action (including the new "can't delete the active/last theme" cases) silently did nothing
  visible until this fix.
- **Outlook person-switcher banner hide-duplicate-error fix + User Management connection icons
  (v1.348.0)** — two small, independent asks. (1) The Outlook Calendar panel's person-switcher
  (viewing a colleague's calendar) rendered TWO error surfaces for the same failure at once —
  the friendly amber "requires app-only Graph" banner (`meta.fallback`) and, directly underneath
  it, the raw Graph error text (`error`, e.g. `Calendar fetch failed: ... ErrorInvalidUser ...`)
  — because `GET /api/outlook/calendar`'s catch branch (`routes/outlook.ts`) sets both on the
  same response when the target user isn't Outlook-connected. `CalendarPanel.tsx` now suppresses
  the raw-error box whenever the friendlier banner is already showing it
  (`error && !showFallbackBanner`), and the banner itself leads with a bold **"Outlook Not
  Connected!"** (new `calendar.person_switcher.not_connected_prefix` key) before the existing
  explanation, translated in all 7 locales. (2) See §14's User Management bullet — a
  **Connections** column (flat single-team view) shows Salesforce/Outlook status icons read
  straight off `user_integrations` (one extra query added to the existing `GET /users` roster
  fetch, no live SF/Graph calls, no per-user round trips), plus a per-icon, opt-in **Verify**
  button that makes a real live probe (`conn.identity()` / Graph `GET /me`) for exactly the one
  row clicked — reusing the identical liveness check `/auth/salesforce/status` and
  `/auth/microsoft/status` already run for a user checking their OWN connection in My Settings,
  just admin-triggered against someone else's stored token. Deliberately never automatic or
  bulk: verifying N users is N separate external OAuth-session probes with no batch endpoint on
  either provider, so autofiring it for a full roster on page load would be exactly the
  performance/rate-limit hit the feature was designed to avoid — discussed with the user before
  writing any code, per their own explicit ask not to build this without an explanation first.
  New `user.verify_connection` audit action (non-destructive, read-only) and
  `POST /api/admin/users/:userId/verify-connection`, gated by the same `canManageUserAlignment()`
  helper Sales Team Alignment (§18 v1.320.0) already uses.
- **Announcements — team broadcast messages (v1.349.0)** — see §14c for the full write-up. New
  Admin → Workplace → Announcements screen: Admins/Team Admins/Leaders post a message targeted
  at a team, a subteam, or one specific person, with a start/end date and an optional "reappear
  daily" setting; it shows in the top-header banner and the notification bell until dismissed.
  Two new tables (`announcements`, `announcement_dismissals`, migration 0150). Leaders are
  restricted to a subteam they lead or a specific person — never team-wide — via
  `canPostAnnouncementTarget()`, exported from `routes/teams.ts` for pglite testability. Reuses
  the shared `notifications` table (`kind: 'announcement'`) so the bell needed zero changes and
  the new `AnnouncementBanner.tsx` (mounted in `PageShell` after `ConnectionsBanner`) rides the
  existing `useNotifications()` poll with no new request. Recurrence resets at the viewer's own
  local midnight via a newly-extracted `localDayKeyFor()` helper (`src/server/lib/localDate.ts`,
  deduplicated out of `digest.ts`/`weekly-recap.ts`'s private copies). **Two real bugs caught
  before shipping**: the admin CRUD routes were first written under `adminRouter`, whose blanket
  `requireGlobalAdmin` gate silently excludes plain Leaders regardless of any per-route
  `requireRole` check — moved to `teamsRouter` (§14c has the full pitfall writeup, worth reading
  before adding any other Leader-reachable admin route); and the notifications read/read-all
  routes' team-scoped filter would have hidden every announcement from a user with a specific
  team selected, since `notifications.teamId` stays null for announcements by design — fixed by
  OR-ing `kind = 'announcement'` into both scopes. 22 new pglite/unit tests
  (`localDate.test.ts`, `announcements/engine.test.ts`, `canPostAnnouncementTarget.test.ts`); all
  7 locales carry real translations, not English-fallback placeholders.
- **Announcements stale-row cleanup (v1.349.1)** — see §14c. Reported same-day: deleting an
  announcement, or editing it out of its active window, left its banner/bell entry showing
  forever, since `syncAnnouncementNotifications()` only ever inserted/refreshed rows for
  currently-active announcements and had no path that removed one once its announcement was
  gone. Fixed with a self-healing diff-and-delete pass on every sync, plus a client-side
  `useNotifications().refresh()` call after any admin create/update/delete so the change feels
  immediate rather than waiting out the poll window. 4 new regression tests.
- **Announcement/notification links + text wrapping (v1.349.2)** — see §14c. A pasted URL or
  email in a message rendered as dead text; new `src/client/lib/linkify.tsx` turns either into a
  real link, shared by the bell dropdown, the bottom toast, and `AnnouncementBanner.tsx`. Also
  fixed a real overflow bug in the same three surfaces — a long unbroken URL pushed the card
  wider instead of wrapping, the classic flex-child-has-no-`min-w-0` trap; fixed with `min-w-0` +
  Tailwind's `break-words` on the message element in all three places.
- **Admin watermark left-edge gap, actually root-caused this time (v1.349.3)** — a third round on
  the same `Admin.tsx` world-map watermark div §18's v1.331/v1.331.1 bullets already cover twice.
  Reported again with a screenshot: a flat ~48px gray gap between the sidebar and the globe on a
  wide window, present even after `background-size: cover` (v1.331.1) — because `cover` alone was
  never actually the whole story. The div's `backgroundPosition` was `right -3rem center`, and on
  a content pane wider than it is tall (routine on a wide monitor, since `world.webp` is
  2400×1538 landscape), `cover`'s scale factor is WIDTH-constrained — the scaled image's width
  matches the container exactly, leaving **zero** horizontal overflow for `cover` to crop from.
  With zero slack, the `-3rem` offset has nowhere to pull image content from on the left; it just
  exposes 48px of raw, un-blended page background — reproduced and pixel-confirmed in a headless
  Chromium repro (flat `rgb(249,250,251)` for exactly 48px, then the image's `rgb(234,235,236)`
  starts). `cover`'s "always fully covers the container" guarantee, the whole reason it was
  chosen over a stretch/color-patch fallback, only holds at a **plain edge position** — any
  offset can reopen exactly this gap depending on the container's aspect ratio at a given window
  size. Fixed by dropping the offset (`right center`); confirmed via the same pixel-sampling
  method that the watermark texture now starts at x=0 with no flat band. **Actually
  screenshot/pixel-verified this time**, unlike v1.331.1's own admission that it shipped
  unverified and was wrong — don't repeat that: this specific watermark div has now broken twice
  from an un-verified "looks right in the diff" change, so treat any further edit to its
  `backgroundPosition`/`backgroundSize` as requiring a live check at a wide AND a narrow viewport
  before shipping, not just a re-read of the CSS.
- **Announcements: custom header-banner icon + light/dark colors; Toast: real severity styling
  (v1.349.4)** — see §14c. Two independent follow-ups requested together. (1) An admin can now
  pick a custom icon and a color for it per announcement — but ONLY the top-header banner ever
  renders it; the bell and the bottom toast always show the plain severity icon, enforced with a
  one-line `n.kind !== 'announcement'` carve-out in the bell's existing icon ternary rather than a
  second code path. The color is a genuine light/dark PAIR (`iconColorLight`/`iconColorDark` on
  both `announcements` and, mirrored, `notifications`), not one value assumed to work in both
  themes — resolved live in JS against the viewer's own `useTheme()` state, no CSS `dark:` class
  trickery needed. New shared `src/client/components/ui/color-picker.tsx`, extracted from
  `ThemingConfig.tsx`'s previously-private `ColorField` (swatch + hex input + a `react-colorful`
  popover) — chosen deliberately over a second native `<input type="color">` (what Activity Types
  and Flight Deck already use for their own single, non-dark-mode-aware icon color) because
  `ThemingConfig.tsx` had already paid to move OFF native color inputs after one froze users'
  browsers via the OS eyedropper; reusing the proven picker for a new light+dark pair avoids
  reintroducing that bug class. Preserved that page's ~30-field "stable per-field callback so each
  picker's own `memo()` short-circuits" performance property via a `useMemo`-built closure map,
  rather than a fresh inline closure per field that would have silently defeated the memoization.
  (2) The bottom-of-screen `NotificationToast` had never respected severity at all — a hardcoded
  blue `Bell` icon on a hardcoded blue background for every notification. New
  `TOAST_SEVERITY_STYLES` (green/orange/red, real light/dark classes) — deliberately a SECOND map,
  not a change to the shared `SEVERITY_STYLES` the bell dropdown and the banner's border still use
  (those stay blue/amber/red, since neither was reported as wrong). Applies to every notification
  kind shown via the toast, not just announcements, since the toast already read `top.severity`
  for every kind — this just makes it mean something visually. 2 new pglite tests confirm
  icon/color fields flow end to end from `announcements` through `getActiveAnnouncementsForUser()`
  and `syncAnnouncementNotifications()` onto the synced `notifications` row.
- **Announcements: duplicate banner on a still-active announcement, fixed (v1.349.5)** — see
  §14c's new "Duplicate banner" note. Reported with a screenshot: two identical banner rows for a
  single announcement in the admin's own list. `syncAnnouncementNotifications()`'s v1.349.1
  cleanup only ever checked whether a row's announcement id was still active — it never checked
  whether that SPECIFIC row's per-day `dedupeKey` was still today's, so an announcement active
  across consecutive days (never dismissed) kept accumulating one surviving row per day instead of
  ever replacing the previous day's. Fixed by comparing against the exact set of `dedupeKey`s just
  upserted in the current sync rather than just announcement ids — a simpler check that subsumes
  the original deleted/deactivated case too. New regression test backdates a synced row's
  `dedupeKey` to simulate a prior day, syncs again, and asserts exactly one row survives.
- **CodeQL fix: incomplete SOQL escaping in Opportunity Relink's live-record read (v1.349.6)** —
  GitHub Code Scanning flagged `fetchLiveOpportunitySnapshot()`
  (`services/salesforce/relinkOpportunity.ts`, §7's Opportunity Relink feature) with the same
  `js/incomplete-sanitization` rule the v1.342.1 ticket-search fix already addressed elsewhere:
  the query built its `WHERE Id = '...'` clause with `oppId.replace(/'/g, "\\'")` — escaping
  single quotes but never the backslash character itself. Since a SOQL string literal treats `\`
  as its own escape character, an input containing a literal backslash immediately before a
  quote can "absorb" the escaping backslash meant for that quote (`\\'` parses as one escaped
  backslash, then an UNESCAPED, string-terminating `'`), letting the rest of the crafted input
  fall out of the string literal and be interpreted as SOQL syntax — a real injection primitive,
  not just a lint nit. This exact class of bug is why `safeSoqlLiteral()`
  (`services/salesforce/soql.ts`) exists — `.replace(/\\/g, '\\\\').replace(/'/g, "\\'")`,
  escaping backslashes FIRST — and is already used by 12 other files in this codebase (including
  `referenceResolver.ts`'s own equivalent helper). `relinkOpportunity.ts` was simply never wired
  up to it; fixed by importing and using `safeSoqlLiteral()` in place of the inline, incomplete
  `.replace()`. Grepped the rest of the codebase for the same naive single-quote-only pattern
  (`replace(/'/g`) to confirm this was the only unescaped instance — every other raw-SOQL
  string-literal interpolation site already goes through `safeSoqlLiteral()`, an equivalent
  backslash-first helper, or an alphanumeric-only strip that can't carry a quote or backslash at
  all. No behavior change for any well-formed Salesforce Id (15/18-char alphanumeric — the normal
  case); this only changes handling of a maliciously-crafted `oppId`, which per §7 arrives from a
  `requireRole('leader', 'admin')`-gated route body, not raw public input — still fixed as
  defense-in-depth, matching this repo's existing "always use the shared literal-escaping helper,
  never hand-roll it" convention regardless of the caller's trust level.
- **MCP: claude.ai web (Connectors) documented + in-app setup guidance (v1.350.0)** — a user asked
  how to connect ImpactIQ's MCP server (§ above; full detail in `docs/mcp.md`) from claude.ai's
  web app specifically, which surfaced a real, previously-undocumented gap: that surface's own
  "Add custom connector" dialog (Settings → Connectors) takes only a Name and a Remote MCP server
  URL — no field for an `Authorization` header or API key — whereas ImpactIQ's MCP server has
  always authenticated purely via a static Bearer `mcp:read` token, with no OAuth flow (a
  deliberate, already-documented choice — see `docs/mcp.md`'s Roadmap). So a Bearer-token-only
  server cannot be reliably connected through that exact dialog today, unlike Claude Desktop,
  Claude Code CLI, Cowork, and n8n's MCP Client Tool node, all of which accept a custom header
  directly and already worked. This is a real product-surface gap, not a configuration mistake —
  documented as such rather than glossed over.
  - `docs/mcp.md` — new **claude.ai (Web) — Connectors** section (exact dialog fields, what
    happens after Continue, and the caveat) placed first under "Configuration snippets", a
    **"Which client should I use?"** comparison table answering the question up front, and an
    update to the existing "OAuth-based MCP auth — deferred indefinitely" Roadmap bullet noting
    this is the first concrete example of the "third-party MCP clients need access" trigger it
    was already waiting on — informational only, doesn't reopen or reprioritize that decision by
    itself.
  - **My Settings → API Keys** (`ApiKeysSection.tsx`) — a new `ClaudeConnectBlock` shows a
    ready-to-paste Claude Desktop/Code `mcp.json` snippet **with the just-created key's real
    value already filled in**, right under the existing "copy this key now" box, whenever a
    newly-created key includes the `mcp:read` scope (gated on `showKeyScopes`, captured
    alongside the raw key at creation time since the scope picker resets afterward) — plus the
    same web-Connectors URL + caveat next to it. A second, persistent, collapsed-by-default
    "Using an mcp:read key with Claude" panel (reusing the same component with a placeholder
    token) covers the same ground for anyone revisiting the page later, since the real key value
    is never shown again after creation.
  - **Admin → Integrations → MCP Server** (`McpServerConfig.tsx`) — the same web-Connectors
    steps + caveat added as a third snippet alongside the existing n8n and Claude Desktop ones in
    the "Connection details" collapsible, so an IT admin sees the identical guidance where they
    already look for connection info.
  - i18n: 9 new keys (`settings.api_keys.mcp_connect_*` ×6, `admin.mcp_server.web_connector_*`
    ×3) translated into all 7 locales, not left on the English-`defaultValue` fallback.
- **Markdown formatting help icon on every notes field (v1.351.0)** — a user shared a screenshot
  of a typical Markdown-syntax cheat sheet and asked for something similar next to every notes
  field, since notes support Markdown (`MarkdownProse`/`markdown-prose.tsx`'s `ReactMarkdown` +
  `remarkGfm` + `remarkBreaks` pipeline) but nothing in the app ever told a contributor that, let
  alone how to use it. New shared `src/client/components/ui/markdown-help.tsx`
  (`MarkdownHelpPopover`) reuses the existing click-to-open `InfoPopover` component (the
  established app-wide convention for this kind of explainer, e.g. `SfRelationshipHelp.tsx`) rather
  than a new hover-only tooltip. Deliberately short — 8 things someone actually reaches for in a
  note (bold, italic, heading, bullet list, numbered list, link, code, blockquote), not the full
  CommonMark spec — plus a one-line tip that a single Enter is enough for a line break (no blank
  line needed), since `remarkBreaks` is what makes that true here and it's the one behavior most
  likely to surprise someone used to plain-CommonMark Markdown. Each "renders as" cell runs the
  syntax through the exact same `ReactMarkdown`+`remarkGfm` pipeline and `.md-body` CSS class the
  real saved note uses, so the cheat sheet can never visually drift from what a note actually
  looks like once saved — it's a live preview, not a static screenshot or hand-written HTML
  approximation. Wired into all three real notes-composition surfaces: `NotesDrawer.tsx`'s shared
  `NotesPanel` draft composer (covers both the standalone per-activity Notes drawer and the Log
  Activity drawer's own embedded Notes tab, since both render the same component — one change,
  both surfaces), `ActivityForm.tsx`'s create-mode inline Notes field, and `MyNotes.tsx`'s
  note-body editor (icon placed above the textarea, right-aligned, shown only in edit mode).
  `ActivityForm.tsx`'s separate "Event description body" field was deliberately left untouched —
  confirmed it is never Markdown-rendered anywhere, so an info icon there would be misleading.
  Live-verified in a real browser session (Playwright against the local dev server) at all three
  locations: the popover opens correctly, renders the live two-column table without clipping
  inside the Log Activity drawer / Notes tab / My Notes panel, and introduces no new console
  errors (two pre-existing, unrelated React hydration warnings surfaced during testing — a nested
  `<button>` in `DeletedActivitiesSection` and a `<div>`-in-`<p>` in `ImpactCard`/`AcvImpactTiles`
  — neither touched by this change).
- **Setup wizard: shared branded background + Dokploy wording removed (v1.352.0)** — two
  follow-ups after investigating a "Bad Gateway" deployment report (root-caused to a
  Docker-network gap between a separate Dokploy host and the app's VM, unrelated to the
  codebase) that involved actually reaching `/setup` for the first time in a while. (1) The
  Setup wizard used its own plain gray gradient page background instead of the same branded
  blue-gradient + `/world.webp`-watermark background every other pre-auth page (Login,
  ForgotPassword, ResetPassword) already shares via `<AuthShell>`. `AuthShell` gained an opt-in
  `scrollable` prop (default `false`, so the three existing short/fixed-height pages are
  byte-for-byte unaffected) — the default layout's `overflow-hidden` + `align-items: center`
  would silently clip a page whose content can genuinely exceed one viewport (this 9-step
  wizard), since `align-items: center` combined with a scrollable overflow is a well-known
  flexbox pitfall where content is clipped on the leading edge with no way to scroll up to it.
  `scrollable` mode instead top-aligns the cross axis and switches to `overflow-y-auto`; the
  corner chrome (theme toggle, language/help, version stamp) and the watermark switch from
  `absolute` to `fixed` so they stay pinned to the viewport during a scroll rather than
  scrolling away with the content — harmless for the three non-scrolling pages, since `fixed`
  and `absolute` render identically there. `Setup.tsx` now wraps itself in `<AuthShell
  scrollable>`; its own header, stepper, and footer text (which sit directly on the backdrop,
  not inside the white card) switched from light-background-oriented `text-gray-900 dark:...`
  classes to fixed white/light styling — the same "backdrop is always dark regardless of app
  theme, so its chrome uses fixed colors, not `dark:` conditionals" convention `AuthShell`'s own
  chrome already follows — since the old classes would have been near-invisible against the new
  permanently-dark background. Verified live at a small viewport (forcing real overflow) that
  the previously-hidden bottom of the card becomes reachable by scrolling and the chrome stays
  pinned, not just that short content looks right. (2) Separately, the user asked to remove
  Dokploy-specific wording from the wizard since a specific deployment target isn't using it —
  7 keys across all 7 locales (`setup.step1.hint`'s "In Dokploy, use the service name as the
  host" and 6 keys in `setup.step9.*`'s "paste into Dokploy → Environment / click Redeploy in
  Dokploy" instructions) were genericized to platform-neutral language ("your deployment
  platform's environment settings" / "redeploy or restart the app") — this app already
  documents itself as compatible with Dokploy OR a bare Azure VM OR plain `docker compose`
  (§17), so hardcoding one platform's UI terminology into the actual product wizard was already
  a latent inconsistency independent of this specific report.
- **Setup wizard: Initial Admin Account now enforces real password complexity (v1.353.0)** —
  Step 2's password field only ever checked `length >= 8`, both client-side (`adminInputValid`)
  and server-side (`AdminSchema`'s `z.string().min(8, ...)`) — meaningfully weaker than the
  shared `PASSWORD_RULES`/`validatePasswordComplexity()` policy (§4/§5, `shared/schemas/
  password.ts`: 10+ chars, upper/lower/number/special) every OTHER password-write path in the
  app already enforces (self-service change, forgot-password reset, admin reset). That gap was
  backwards: this is the very first account created in a fresh install, always granted App
  Admin outright, and it could end up with a weaker password than any account created after it.
  Fixed on both sides, matching the exact pattern `routes/auth.ts`/`routes/admin.ts` already use
  elsewhere (a separate `validatePasswordComplexity()` call after the schema parse, returning
  `Password must satisfy: <failed rules>` on failure — not baked into the Zod schema itself, to
  stay consistent with those call sites rather than inventing a second validation style).
  Client-side, `Setup.tsx` now imports the same `PASSWORD_RULES`/`validatePasswordComplexity`
  Login.tsx's own change-password step already uses, gates `adminInputValid` on `.ok` instead of
  a bare length check, and renders the identical live checklist (`Check`/`X` icon per rule,
  green once satisfied) under the password field — so a fresh install sees exactly the same
  requirements, in the same form, as every other password screen in the app. The now-stale
  `password_placeholder` copy ("At least 8 characters" — already wrong before this fix, since
  the real floor has been 10 chars) was updated to a generic "Choose a strong password" across
  all 7 locales, since the live checklist is now the actual source of truth for what's required.
  Live-verified end-to-end in a real browser: a weak password shows the correct red/green
  per-rule state and keeps Create Admin Account disabled; a fully-compliant password enables it
  and the account is created successfully.
- **World-map watermark extended to My Settings and Guide (v1.354.0)** — both pages previously
  rendered on a plain, watermark-free background while every Admin page has carried the
  `/world.webp` watermark since v1.146.0. Requested to make the two pages visually consistent
  with Admin. Copied the exact div — same `background-image`, `opacity-20`/`dark:opacity-15`,
  `mix-blend-multiply`/`dark:mix-blend-screen`, and `background-size: cover` at a plain `right
  center` position `Admin.tsx` already uses — rather than reintroducing any variation, given this
  exact watermark has broken three separate times before (v1.331.0, v1.331.1, v1.349.3) from
  positional-offset/color-patch changes that looked right in the diff but weren't. Both pages'
  existing scrollable content wrapper (`relative flex-1 overflow-y-auto p-6`) gained the
  watermark as an `absolute inset-0` sibling plus a `relative flex flex-col gap-*` wrapper around
  the real content, matching `Admin.tsx`'s own two-layer structure — the outer div stopped being
  a flex container itself so the watermark can honestly cover `inset-0` of it. Per this exact
  watermark's own documented history, verified live in a real browser (Playwright) rather than by
  CSS re-read alone: both pages at a wide (1600px) and a narrow (900px) viewport, in both light
  and dark mode, with no console errors and no seam/gap at either width. Dark mode is
  faithfully as subtle as Admin's own dark-mode watermark against dense content (confirmed by a
  side-by-side screenshot of Admin's dark mode) — not a regression, just how `opacity-15
  mix-blend-screen` reads against this app's near-black dark background.
- **World-map watermark invisible in dark mode, fixed (v1.355.0)** — reported with light/dark
  screenshots of the same Admin page: the watermark is clearly visible in light mode but
  disappears entirely in dark mode on Admin, My Settings, and Guide. Root-caused by directly
  sampling `world.webp`'s own pixels (Python/Pillow): the asset is near-black navy (avg RGB
  ~1,7,16), built for `mix-blend-multiply` onto a light background — `multiply` darkens using
  the blend layer's own color, which works when that layer is dark. `mix-blend-screen` (the
  dark-mode treatment since this watermark shipped) only ever LIGHTENS using the blend layer's
  own color, so screening the same near-black asset onto the dark page background had almost
  nothing to lighten with and was invisible regardless of any opacity value — ruling out
  `dark:opacity-15` as ever having been the real cause. Fixed with `dark:[filter:invert(1)]`,
  which flips the asset to near-white first so `screen` has something to actually lighten with —
  the dark-mode mirror of light mode's multiply-onto-white, no new image asset needed. Verified
  with blend-math arithmetic (the screen formula against this app's actual dark background
  color) before shipping, mirroring an equivalent light-mode darkening delta, per this exact
  watermark's own repeated history of breaking from unverified changes (v1.331.0, v1.331.1,
  v1.349.3). Applied identically to `Admin.tsx`, `Settings.tsx`, and `Guide.tsx` (all three
  share the exact same watermark div).
- **Pentest remediation: 5 findings fixed, receipt delivered (v1.356.0)** — an external manual
  penetration test (September 2026) reported 2 High, 2 Medium, and 1
  Informational finding. All 5 fixed in one pass, plus the same root-cause bug class was swept
  across every other route sharing it (not just the literal routes the tester happened to test).
  - **F-04 (High, self-escalation)** — `PATCH /teams/:teamId/users/:userId/role` and
    `POST /teams/:teamId/users` both auto-granted global `users.isAppAdmin` whenever a role was
    set to `"admin"`, gated only by `requireRole('admin')` — which a `team_admin` satisfies on
    their OWN team, including against their own userId. A team_admin could therefore PATCH their
    own role to `"admin"` and instantly become a full App Admin with one API call. Fixed by
    requiring the CALLER to already be an App Admin before either route will set a target's role
    to `"admin"` (`errors.users.admin_role_requires_app_admin`, all 7 locales) — `team_admin`
    remains available to team_admin callers and is functionally identical for team-scoped
    permissions (`rbac.ts`'s `ROLE_HIERARCHY` treats them as equal), so nothing legitimate is
    lost. Paired with a client-side fix: User Management's Role dropdown now hides the "Admin"
    option unless the viewer is already an App Admin, so the UI doesn't offer an action the
    server will now reject.
  - **F-03 (High, IDOR)** — the report demonstrated one instance (a Channel-only team_admin
    modifying a Sales team's activity type via `PATCH /teams/:teamId/activity-types/:typeId`) but
    flagged "similar code patterns were identified in other routes, but those routes were not
    individually tested." A full audit found the identical missing-ownership-check pattern on
    **~23 routes**: `requireRole('admin')` correctly checks the caller's role ON the `:teamId` in
    the URL, but the mutating query filtered by the nested resource's own id ALONE, never
    re-checking it actually belongs to that team — so any `teamId` a team_admin legitimately
    administers could be paired with any other team's resource id. Fixed across activity-types,
    their sf-extras and subtypes, keyword-rules, attach-rate-fields, nudge-rules and their
    translations, nudge-dismissals, flight-deck-items and their translations, plus (lower
    severity — `requireAppAdmin`-gated, so no cross-team privilege GAIN, but the same
    data-integrity risk from a mistyped id) subteams and sf-field-mappings. Two distinct fix
    shapes depending on the resource: a direct `AND team_id = :teamId` added to the query for
    tables with their own `team_id` column, or a full ownership-chain join for resources nested
    two levels deep (e.g. an sf-extra's `AND type belongs to :typeId AND type.team_id =
    :teamId`). Keyword-rule and nudge-rule ownership specifically respects the
    `keyword_rule_teams`/`nudge_rule_teams` junction tables (CLAUDE.md §11 v1.297's own fix for
    the identical `team_id`-column-vs-junction split) rather than checking the home `team_id`
    column alone, which would have incorrectly 404'd a rule validly multi-assigned to a second
    team — extracted into shared `isKeywordRuleVisibleToTeam()`/`isNudgeRuleVisibleToTeam()`
    helpers (exported from `admin.ts` for pglite testability, replacing 7 duplicated inline
    checks). Also fixed in the same pass: several DELETE handlers returned 200 even when nothing
    was actually deleted.
  - **F-01 (Medium, SSRF via Salesforce `loginUrl`)** — the Salesforce integration's `loginUrl`
    accepted any `https://` URL with no domain restriction, used both as a blind-SSRF probe (the
    admin "Test" button reflects the raw HTTP status back) and — critically — as the OAuth
    token-exchange host whenever a connecting account has no stored `instanceUrl`. The report
    demonstrated a full chain: point `loginUrl` at an attacker server, disconnect your own SF
    connection so the fallback path is used, get a legitimately-signed OAuth `state` from the
    real `/auth/salesforce` flow, then hit the callback with a fabricated code — Salesforce
    Connected App `client_secret` gets POSTed to the attacker's server during the exchange. Fixed
    with a new `assertSalesforceLoginUrl()` (`services/net/ssrfGuard.ts`) layering a
    `*.salesforce.com`/`*.force.com` host-suffix allowlist (proper suffix match, not `.includes()`
    — blocks both `evil-salesforce.com` and `salesforce.com.evil.net`) on top of the **already-
    existing** `assertPublicHttpsUrl()` guard (HTTPS-only, DNS-resolved private/loopback/
    metadata blocklist) that, per a full audit, had been wired into the pre-auth setup wizard's
    own test routes since it was built but never into the always-on admin routes that actually
    matter post-install — `README.md`'s claim that SSRF guards cover "admin test-* endpoints" was
    accurate for zero of the four integrations before this fix. Validated at config-save time
    (a bad `loginUrl` is now rejected before it's ever stored) AND at every outbound call site
    that actually sends the client_secret (`exchangeAuthorizationCode()`, `refreshAccessToken()`
    in `services/auth/salesforce.ts`) as defense in depth against a legacy stored value.
  - **F-02 (Medium, SSRF via Azure OpenAI `endpoint`)** — same unvalidated-URL shape as F-01,
    except the report demonstrated the app's own AI classification feature (`classifyWithAI()`,
    runs on every calendar event, not just when an admin clicks "Test") sending real calendar
    subject/body content to an admin-configured attacker host. Fixed with
    `assertAllowedAzureOpenAiEndpoint()` restricting `endpoint` to `*.openai.azure.com` by
    default, plus a new admin-configurable `allowedCustomHost` field (`AzureIntegrationConfig`,
    Admin → Integrations) for an org using Azure OpenAI Private Link/a custom domain — an
    explicit, deliberate opt-in exception rather than reopening the field to any host. Validated
    at config-save time and, since that's the call site that actually matters, directly inside
    `classifyWithAI()` itself (degrades to `return null`, the function's existing
    not-configured contract, on a disallowed endpoint — never throws into the calling
    classification path). Same-pattern hardening applied in the same pass since the guard
    already existed and the fix is identical: the Okta admin config/test routes (genuinely
    vulnerable — `domain` had no validation either) and the per-team Slack Incoming Webhook
    sender (`services/nudge/slack.ts`) both get the generic `assertPublicHttpsUrl()` guard, no
    domain allowlist (both legitimately support fully custom/enterprise domains). Microsoft's
    admin test route was audited and found NOT vulnerable — its host is a hardcoded literal
    (`login.microsoftonline.com`), only `tenantId` is interpolated into the path, which can't
    redirect to a different host.
  - **F-05 (Informational, Flight Deck unvalidated URL schemes)** — `linkValue` and `screenshots`
    accepted any string with no scheme/format validation; not exploitable today (a `data:` URI
    in `linkValue` just opens a blank tab via `window.open`, and an SVG-with-onload payload in
    `screenshots` doesn't execute since it renders via `<img src>`, confirmed by checking the
    actual client render path before reusing this reasoning) but a real missing-validation
    defect per the report's own recommendation. `linkValue` now requires `http://`/`https://`
    for an `external_url` link, or an in-app path starting with `/` (never `//`) for `app_page`
    — validated against the EFFECTIVE value on a PATCH (patched value, or the existing stored
    one when a field is omitted), mirroring the "effective value" pattern the keyword-rules PATCH
    handler already uses for its action/type pair. `screenshots` now reuses the exact MIME
    allowlist (`image/png|jpeg|svg+xml|bmp|x-ms-bmp`) `validateLogoDataUrl` already established
    for theme-logo uploads (v1.289 C2) — confirmed safe to include `svg+xml` here too since
    Flight Deck screenshots render via the same `<img src>` path theme logos do.
  - **Regression tests** — `ssrfGuard.test.ts` (13 tests, `node:dns` mocked for hermetic,
    network-free coverage of the private-IP/loopback/metadata blocklist, the DNS-rebinding case,
    and both new domain allowlists including the exact lookalike-host bypass attempts a real
    attacker would try) and `adminTeamScoping.test.ts` (6 pglite tests covering the junction-table
    helper functions plus the direct-child-table and two-level-nested-table query SHAPES the
    other ~21 F-03 fixes reuse, rather than one test per literal route).
- **4 new Theme presets (v1.357.0)** — Admin → Themes' "Preset starting points" row
  (`theme-presets.ts`) gains Purple, Dark Purple, Dark Blue, and Dark Yellow, each a full
  light+dark palette following the exact convention every existing preset already uses
  (sidebar gradient light-top/dark-bottom, AA-contrast-checked text colors, etc.). Dark Yellow
  uses the requested `#F2B200` directly as the dark-mode primary/link accent (bright gold reads
  well against a dark surface) with a deeper gold (`#8A6A00`) carrying the light-mode
  primary/link, since `#F2B200` itself fails text contrast on white.
- **Sidebar app-name color, themeable (v1.358.0)** — the "ImpactIQ" wordmark next to the logo
  in the collapsed/expanded sidebar (`nav.tsx`) was the one piece of sidebar chrome still on
  hardcoded Tailwind classes (`text-blue-600 dark:text-blue-400`) rather than a theme variable,
  despite everything else in that footer/header block (muted text, borders, pill bg, nav hover,
  user pill name/subtitle) already following the `ActiveThemeColors`/CSS-custom-property
  pattern established back in v1.36. Added a new light/dark color pair — `appNameLight`/
  `appNameDark` on `ThemeColors`/`ActiveThemeColors`, `--color-app-name-light`/`-dark` in
  `store/branding.ts`'s `applyThemeColors()`, a new `COLOR_FIELDS` row in `ThemingConfig.tsx`'s
  admin editor (reuses the existing shared `ColorPicker`, no new component needed) — and wired
  it into `nav.tsx` via the same `useMemo`-with-CSS-var-fallback pattern every other themed
  sidebar value already uses (`var(--color-app-name-dark, #60a5fa)` / `var(--color-app-name-
  light, #2563eb)`, the fallback hexes matching the old Tailwind blue exactly so a theme that
  hasn't set this yet renders identically). No DB migration needed — `app_themes.colors` is a
  single `jsonb` column (§14), so a new field is just a new key in that blob, already covered
  by `PATCH /api/admin/themes/:id`'s existing pass-through. All 9 presets in `theme-presets.ts`
  (the 5 original plus the 4 shipped in v1.357.0 above) were given a matching `appNameLight`/
  `appNameDark` pair, reusing each preset's own `sidebarActiveTextLight`/`sidebarActiveTextDark`
  values so the wordmark reads as the same accent color as the active-nav-item highlight within
  that preset, rather than an arbitrary unrelated color.
- **Sidebar app-name color fix: it never actually saved (v1.358.1)** — reported immediately
  after v1.358.0 shipped: editing the new sidebar app-name color on ANY theme, including the
  default Acme Brand theme, silently didn't persist — reload and it was back to the old
  hardcoded blue. Root cause: `PATCH /api/admin/themes/:id`'s `themeColorsSchema`
  (`admin.ts`) validates the `colors` JSON blob with a plain `z.object({...})`, and Zod strips
  any key not explicitly declared in the schema by default — the exact footgun a comment
  already sitting right above `sidebarTextMutedLight` in that same schema calls out ("Added in
  PR #62 — Zod strips unknown keys silently, so these have to be declared explicitly or new
  sidebar color fields never persist"). `appNameLight`/`appNameDark` were added to
  `ActiveThemeColors` (client store), `ThemeColors` (admin editor type), and `theme-presets.ts`
  in v1.358.0, but never added to this server-side Zod schema — so every save request stripped
  them before the row ever reached the database, on every theme, not just the default one (the
  Acme Brand theme just happened to be the one the reporter was actively testing on). Fixed
  by adding both fields as `z.string().optional()` to `themeColorsSchema`, matching the exact
  pattern (and comment) already there for every other v1.36+ color addition. **Lesson: this
  schema is the one place a genuinely new theme color field must ALSO be added — the client-side
  type/store/preset changes alone are not sufficient, and this exact bug class has a standing
  comment in the file warning about it.**
- **Header quarter-countdown pill: business days AND calendar days (v1.359.0)** — the header's
  `<QuarterCountdown>` pill (`quarter-countdown.tsx`, rendered by every page's `<PageHeader>`)
  showed a single number: business days left in the current quarter (calendar or fiscal, per
  Admin → Calendars). Requested to show a second number alongside it — total calendar days left
  in that same quarter — as `#/#` (business/calendar), with the hover tooltip explaining which
  number is which. Added `calendarDaysBetween()` (a plain whole-day `Date` diff, no weekday/
  holiday exclusion, over the exact same `[now, quarterEnd)` window `businessDaysBetween()`
  already counts) and rendered both as `{daysLeft}/{calendarDaysLeft}`. The tooltip is now a
  real i18n string (`nav.quarter_countdown.tooltip`, translated in all 7 locales) rather than
  the previous hardcoded English `title` — interpolates the fiscal label plus both counts, e.g.
  "Q3 FY27 · 32 business days left / 45 calendar days left".
- **Sidebar reorganization: My Settings becomes an icon button; theme choice moves into My
  Settings (v1.360.0)** — two related sidebar cleanups. (1) My Settings was previously a regular
  entry in the main nav link list (`nav.tsx`'s `allLinks`, `Plug` icon, between My History and
  Guide). It's now an icon-only button in the footer block, to the left of Logout, below the
  border-top divider — the same row/position the removed theme-toggle button used to occupy —
  using the `SlidersHorizontal` lucide icon with a `title` tooltip (`nav.settings`, unchanged
  key) since it's icon-only now (§19c convention). Still gated on `hasPermission(user,
  'settings')`, same as when it was a regular link — Role Management's page-key matrix keeps
  working unchanged. (2) The light/dark toggle button that used to sit in that exact spot moved
  to My Settings → Preferences as a new **Appearance** card (`ThemePreferenceCard`,
  `Settings.tsx`), first section in the Preferences group, above Timezone — a 3-way Light/Dark/
  System segmented control (`Sun`/`Moon`/`Monitor` icons). This required widening `theme.ts`'s
  store from a plain `Theme = 'light'|'dark'` to a separate `ThemePreference = Theme | 'system'`:
  `useTheme()` now returns both `.theme` (still the resolved `'light'|'dark'`, unchanged for
  every existing dark:/JS-conditional consumer — `App.tsx`, `page-header.tsx`,
  `AnnouncementBanner.tsx`, `FlightDeckModal.tsx`, `nav.tsx` itself all keep reading `.theme` with
  zero changes) and `.preference` (the raw stored choice, new). `setTheme()` now accepts a
  `ThemePreference` — a superset of the old `Theme` parameter, so `AuthShell.tsx`'s own separate
  pre-auth light/dark toggle (Login/Setup/etc., untouched by this change since those pages have
  no My Settings to move a control into) keeps compiling and working identically. Picking
  "System" subscribes to `matchMedia('(prefers-color-scheme: dark)')`'s `change` event and
  re-resolves live if the OS setting changes while `system` is the active preference — a plain
  "system at time of first load" snapshot (the previous behavior when nothing was in
  localStorage) would have gone stale the moment the OS theme changed later in the session.
- **Color pickers unified onto one component + eyedropper added (v1.361.0)** — the admin noticed
  Admin → Themes had two visually different color-picking UIs side by side (the Email Template
  panel's native `<input type="color">`, with its browser-native swatch/gradient/RGB-fields/
  eyedropper popup, next to every other field's `ColorPicker` component — swatch + hex input +
  a `react-colorful` gradient popover, no eyedropper) and asked to standardize on the native one
  since its eyedropper is a genuinely useful feature. Investigating surfaced the real reason the
  two ever diverged: the native `<input type="color">` was tried FIRST for theme colors and
  deliberately removed after it froze users' browsers via its OS-level eyedropper (see
  `color-picker.tsx`'s own header comment and this file's v1.35.2/v1.36 history) — standardizing
  back onto it would have reintroduced a bug that was already found and fixed. The admin tested
  the Email Template picker live and didn't reproduce a freeze, which is expected: that failure
  mode was browser/OS-dependent and never reliably reproducible on demand, which is exactly why
  it shipped in the first place and took a real user report to catch. Rather than pick a side
  unilaterally, this was surfaced back to the admin as a 3-way choice; the admin chose the third:
  keep the shared `ColorPicker` everywhere (converting the two remaining native holdouts —
  Email Template's top/bottom bar colors in `ThemingConfig.tsx`, and Activity Types' and Flight
  Deck's own icon-color fields, both called out by name in `color-picker.tsx`'s own comment as
  not-yet-converted stragglers) AND add a genuine eyedropper button to it. The button uses the
  standalone `window.EyeDropper` API (Chrome/Edge only, feature-detected — the button simply
  doesn't render on Safari/Firefox) rather than the native input's built-in one: it samples a
  single pixel color from the screen with no OS-level color-chooser dialog involved, which is a
  different code path from whatever specifically froze the browser before, so it restores the
  eyedropper workflow without reintroducing the mechanism that caused the original bug. Every
  color field in the app — all ~30 theme colors, Email Template's 2 email-only colors, Activity
  Types' type color, and Flight Deck's icon color — now goes through the one `ColorPicker`
  component, so there is exactly one color-picking UI in the app rather than two.
- **Deleted Outlook Activities: Review deep-link fixed + new leader dashboard (v1.362.0)** —
  the user asked to understand (no changes yet) how the "an approved activity is linked to an
  Outlook meeting that has been deleted" top banner and its "This Week's Deleted Activities"
  card actually behave, which surfaced a real usability gap worth fixing: the banner's **Review**
  link always pointed at `/` (today's week) regardless of which week the flagged activity/
  activities actually live in — clicking it when the deletion happened on a meeting from a
  different week landed on today with no matching card and no visible next step, even though the
  bell/banner count (deliberately all-weeks per §10) stayed non-zero. Fixed by having
  `ConnectionsBanner.tsx` fetch the unscoped `GET /api/activities/outlook-deleted` queue once
  whenever the count is non-zero and deep-linking to the EARLIEST flagged item's own week via the
  same `?openActivityId=&startDate=` pattern leader-dashboard drill-downs already use (`WeeklyView.
  tsx` already reads both) — falls back to `/` only if the fetch hasn't resolved yet or genuinely
  finds nothing. (The new hooks had to be placed BEFORE the component's existing `if (!user)
  return null` guard, not after — Hooks can't run conditionally, and the fix's first draft placed
  them after it.) Separately, per the second question raised in that same conversation (does an
  Outlook-side deletion ever show up alongside the Salesforce-side "Activities Disconnected from
  SF" dashboard, or are they unrelated?) — confirmed they're two fully independent detectors with
  zero overlap — the user asked for a matching **Activities Disconnected from Outlook** dashboard
  (§13's Activity group) so a leader/admin has the same at-a-glance visibility Activities
  Disconnected from SF already provides, but for the Outlook side. Presented as a 3-way choice
  before building (read-only matching the SF dashboard exactly / leader can act on anyone's row,
  a new exception to §5's "leaders cannot edit contributor activities" / a personal all-weeks
  page instead) — the user picked the first, keeping the leader/contributor boundary intact: new
  `GET /api/dashboards/outlook-disconnected` (`dashboards.ts`, mirrors `/sf-disconnected`'s exact
  shape — team-scoped, `requireDashboardAccess('outlookDisconnected')`, submitted-only) and a new
  `OutlookDisconnected.tsx` component, both read-only — Keep/Delete stays exclusively with the
  owning contributor via the existing personal queue, this table only deep-links to the
  activity's own week using the same fixed `?openActivityId=&startDate=` pattern. New
  `dashboard.outlookDisconnected` Role Management page key, ships opt-in/unconfigured like every
  other dashboard in this family.
- **Pending deleted-Outlook-meeting indicators on the personal calendar views (v1.363.0)** — a
  direct follow-up request off two screenshots: the Logging-Compliance-style month heatmap
  (`MonthHeatmap.tsx`) and the week-view Outlook Calendar panel (`CalendarPanel.tsx`) both gave
  no visual signal that a day held an activity still awaiting its Keep/Delete decision — a
  contributor had to already know to look inside the "This Week's Deleted Activities" section.
  See §10's new bullet for the full write-up: a small red dot on the month-heatmap cell's
  top-right corner, and a red day number (or a red ring around today's blue-filled circle) on
  the week panel's header, both with an explanatory hover tooltip. `GET /api/activities/
  month-heatmap` gained a parallel `outlookDeletedStarts` array alongside the existing `starts`;
  the main `GET /api/activities` list select gained `outlookDeletedAt` next to the
  pre-existing `outlookDeletedKept` so the week panel's already-loaded activity list can compute
  the flag with no extra request. Deliberately personal-surface-only, matching the rest of §10's
  contributor-scoped review flow — the two leader dashboards (Activities Disconnected from SF/
  Outlook) are untouched.
- **Transparent-table fix on CRM Sync / Nudge History, sidebar "Last logged in" tooltip, and
  Login History retention (v1.364.0)** — three small user-reported items. (1) The world-map
  watermark (`Admin.tsx`, `/world.webp` — see this exact watermark's own repeated history at
  v1.331.0/v1.331.1/v1.349.3/v1.355.0) bled through the table content on Admin → Monitoring →
  CRM Sync (`SyncHistory.tsx`) and Nudge History (`NudgeHistory.tsx`'s History tab), because
  both table wrappers were missing an opaque background — every sibling table on this page
  family (`SfDisconnected.tsx`, `SyncIssues.tsx`, `ActivityHealth.tsx`, `DbHealth.tsx`,
  `SchedulingConfig.tsx`, `NudgeDismissals.tsx`) already carries `bg-white dark:bg-gray-950`/
  `dark:bg-gray-900` on its own wrapper; these two were the only stragglers. Fixed by adding the
  same class to both wrappers — no other change. (2) The sidebar user-identity pill (`nav.tsx`)
  now shows a "Last logged in: <date/time>" hover tooltip in both collapsed and expanded states,
  formatted in the viewer's own timezone via a new `formatDateTimeInTZ()` helper (`lib/tz.ts`,
  alongside the existing `formatTimeInTZ()`). `GET /auth/me` gained a `lastLoginAt` field —
  the caller's own most recent successful `login_events` row, same `MAX(createdAt)` reduction
  the admin roster's "Last Logged In" column (§14, v1.318.0) already uses for viewing OTHER
  users, just scoped to the caller here. New `nav.last_login_tooltip`/`last_login_never` i18n
  keys, translated in all 7 locales. (3) Checked first, per the user's explicit ask, whether a
  `login_events` retention rule already existed anywhere in `src/server/` before writing one —
  it didn't; the table was one of the "previously unbounded log tables" §17 already calls out
  for `audit_events`/`job_runs`/`attach_rate_history`, just never actually given a cull of its
  own. Added a fourth cull to the exact same 6h housekeeping sweep
  (`services/salesforce/writeback.ts`'s `startSyncAuditCull()`), same pattern as the other
  three: a new `LOGIN_EVENTS_RETENTION_DAYS` env var (default 60), documented in `.env.example`
  and §17's env var block.
- **4 more Theme presets: Gray, Teal, Crimson, Dark Green (v1.365.0)** — direct follow-up on the
  v1.357.0 preset expansion. Discussed as an exploratory question first (no code) — asked which
  gaps stood out in the existing 9-preset lineup and what to add, the user confirmed all but a
  proposed Black/OLED and Rose/Magenta pair. **Gray** is a genuinely new preset TYPE, not just a
  new hue — every existing preset (including the two "neutral"-adjacent ones, Midnight Slate and
  Warm Neutral) carries a color cast; Gray is the first with none, for an org that wants a
  colorless, minimal look rather than a brand accent. **Dark Green** completes the "Dark X"
  quartet Dark Purple/Dark Blue/Dark Yellow (v1.357.0) already started — Forest Green had no
  dark-first sibling the way the other three main hues did; it uses a deeper pine/emerald pairing
  (`#064E3B`/`#34D399`) rather than Forest Green's own green-800/green-400-ish tones, the same
  "distinctly deeper, not just a duplicate" relationship Dark Blue has to Ocean Blue. **Teal** and
  **Crimson** fill two hue gaps the original 9 never covered: Ocean Blue is sky-blue/cyan-400,
  distinct from Teal's cyan-800/teal-600 register; Sunset Coral is salmon/pink with a navy link
  accent, distinct from Crimson's deep, single-hue corporate red. All 4 follow the exact
  `theme-presets.ts` structural convention (light-top/dark-bottom sidebar gradient, AA-checked
  text pairs, `appNameLight`/`appNameDark` matching each preset's own `sidebarActiveText`
  convention) — no new fields, no schema change, since a preset is just a literal color-value
  object the admin's Preview/Save flow already round-trips through the existing
  `PATCH /api/admin/themes/:id` `themeColorsSchema`. New `admin.themes.presets.gray`/`teal`/
  `crimson`/`dark_green` i18n keys, translated (not English-fallback) in all 7 locales — this is
  the one label object in `ja.json` that transliterates rather than translates (romanized
  katakana renderings of the English name for `midnight_slate`/`dark_purple` etc., not
  native-word translations), so `gray`/`teal`/`crimson`/`dark_green` follow that same established
  sibling-key convention rather than translating into kanji color words. Brings the total preset
  count from 9 to 13.
- **All 10 open Dependabot alerts fixed via `package.json` overrides (v1.366.0)** — the user
  shared a Dependabot Alerts screenshot (4 High on `fast-uri`, 6 Moderate across `node-csv`,
  `hono` ×3, `qs` ×2) and asked whether more investigation was needed before fixing. It wasn't:
  `npm ls`/`npm audit --json` traced every one to a transitive dependency (`fast-uri` via
  `@modelcontextprotocol/sdk`→`ajv`; `hono` via the same SDK and `@hono/node-server`; `qs` via
  `express`/`body-parser`; `csv-parse` via `jsforce`), and `npm view <pkg> versions`/`npm audit`'s
  own `range` field pinpointed the exact patched version for each. Three were trivial same-major
  bumps that stayed within every parent's own declared semver range (no risk of breaking a
  parent's assumptions): `fast-uri` 3.1.5→**3.1.8** (still `3.x`, within `ajv`'s `^3.0.1`), `hono`
  4.13.0→**4.13.8** (within both `@modelcontextprotocol/sdk`'s `^4.11.4` and
  `@hono/node-server`'s peer `^4`), `qs` 6.15.3→**6.16.0** (within `express`'s `^6.14.0` and
  `body-parser`'s `^6.15.2`). **`csv-parse` needed a real judgment call** — its one GHSA
  (`GHSA-8cw4-87c7-c6xx`, prototype pollution via a malicious CSV column header) was only ever
  patched at **7.0.2**, a major bump beyond what `jsforce` declares (`^5.5.2`, unchanged even in
  its own latest release) and no 5.x/6.x backport exists. Before overriding it anyway, traced the
  actual vulnerable code path: `csv-parse` is only ever invoked from jsforce's OWN Bulk API CSV
  helper (`node_modules/jsforce/lib/csv.js`, imported by `record-stream.js`/`http-api.js`), and a
  repo-wide grep for `conn.bulk`/`bulk2`/`createJob` across `src/server` found this app never
  calls jsforce's Bulk API at all — the "Bulk activity import" feature (§18 Phase 1) is a
  separate, first-party CSV path that never imports `csv-parse`. So the CVE's own vulnerable code
  is dead in this app's usage regardless of version, and forcing the override to 7.0.2 carries no
  functional risk here even though it's outside jsforce's own tested range. User explicitly asked
  to fix all four including this one. All four pinned as new entries in the existing root
  `package.json` `overrides` block (alongside the pre-existing `esbuild`/`nanoid` pattern) —
  npm's override mechanism itself (not a bug in this fix) needed a full `rm -rf node_modules
  package-lock.json && npm cache clean --force && npm install` to actually reify; a stale local
  npm package cache from earlier troubleshooting silently kept resolving the old vulnerable
  versions even after the `overrides` block was correct and a fresh lockfile had been generated —
  worth remembering if a future override "isn't taking effect" despite a clean-looking
  `package.json`/lockfile. `npm audit` now reports 0 vulnerabilities. No source code changes;
  `jsforce` itself also picked up a transitive patch bump (3.10.19→3.10.25, within its own
  existing `^3.10.16` range) as a side effect of the lockfile regeneration.
- **README/docs accuracy pass + new "How to Use ImpactIQ" onboarding manual (v1.367.0)** — two
  asks in one pass. (1) `README.md`'s status line and Feature Highlights bullet list had fallen
  behind — it stopped tracking roughly at v1.349.6 despite the app being at v1.366.0 — so it was
  brought current: version bumped, and new bullets added for the 13 Theme presets (§14) and the
  unified color picker with an `EyeDropper` button (v1.361.0), the Setup wizard's shared branded
  background + full password-complexity enforcement + Dokploy-wording removal (v1.352–1.353), the
  September 2026 pentest remediation (v1.356.0), the Activities Disconnected from Outlook dashboard and the
  personal-calendar pending-decision indicators (§10/§13, v1.362–1.363), the Markdown help-icon
  popover on every notes field (v1.351.0), and the claude.ai web Connectors MCP snippet + its
  known Bearer-token limitation (v1.350.0). `docs/*.md` were spot-checked against the current
  codebase (`db-schema.md`/`api.md` already reference `announcements`/`ticket_picker`/
  `activity_sf_tickets`/`opp_review_dismissals` — genuinely current, not stale) and left unchanged. (2) A new, entirely static **`/guide/how-to-use`** page
  (`src/client/pages/HowToUseImpactIQ.tsx`) is a full onboarding manual distinct from the existing
  per-Activity-Type Guide page — 8 sections (Overview/roles, the Contributor weekly workflow, SF
  linking, Nudges, Leader dashboards, Admin orientation, My Settings, FAQ) each rendered through
  the same `MarkdownProse` component Guide's own Distinctions section already uses, with an
  in-page table-of-contents. Deliberately NOT built as admin-editable DB content the way the
  per-type Guide cards are — this is one static, app-wide manual, not per-team content, so a plain
  React page with real i18n strings is simpler and correct. Reachable only via a new prominent
  banner link at the top of `Guide.tsx` (kept under the same Guide route rather than a new
  top-level sidebar entry, per explicit direction) and routed inside the existing `<PageShell>`
  wrapper via a new `/guide/how-to-use` route in `App.tsx`, so it gets the sidebar/header/logo bar
  like every other page. All headings/labels go through `t()`; the full manual content (a
  `how_to_use` i18n namespace, ~20 keys, several holding multi-paragraph Markdown bodies) plus a
  small `guide.how_to_use_banner_*` set were translated into all 7 locales with real content, not
  the `t(key, 'English default')` fallback — confirmed via `python3 scripts/check-i18n-parity.py`
  (zero missing/extra keys across all 6 non-English locales). **Process note**: the injection
  script that wrote these new keys used Python's default `json.dump` (LF line endings), while
  every existing locale file is CRLF — this produced a git diff that rewrote the entire file
  (every line showing as changed) despite the actual content being identical aside from the
  intended additions. Caught before committing by comparing `git diff --stat` against `git diff -b
  --stat` (whitespace-insensitive) and seeing the diff collapse from ~7,200 lines to ~40 once line
  endings were normalized back to CRLF — worth checking for on any future locale-file edit made
  with a non-JS tool, since a script- or Python-authored change to a CRLF file is an easy way to
  produce this exact false-full-rewrite diff.
- **"This Week's Deleted Activities" section intermittently vanishing, fixed (v1.367.1)** —
  reported directly, with two screenshots minutes apart on the same week: the section (§10) shows
  correctly after a hard page refresh, but disappears again after navigating to a different week
  and back, with no other change. Root cause was the identical unguarded-fetch-race class already
  fixed once in this file for a different hook (§18 v1.321.0's `useActivities.ts` gap):
  `useOutlookDeleted.ts`'s `load()` fires a fresh `GET /api/activities/outlook-deleted?weekStart=`
  on every week change (keyed by `weekStart.toISOString()`) but had no request-ordering guard at
  all — it unconditionally called `setItems`/`setTotalCount` on whatever response came back,
  regardless of which week's request it belonged to. Navigating away and immediately back fires
  two overlapping requests (for the left week and the returned-to week); with no guarantee they
  resolve in the order they were sent, the OLDER request (for the week just left, which may
  legitimately have zero deleted-activity rows) can resolve AFTER the newer one and silently
  overwrite the correct, non-empty result with the wrong week's — the exact "stale response wins"
  race §18 already documented, just recurring in a sibling hook that wasn't touched by that
  original fix. A manual reload works around it because there's only ever one in-flight request
  at that point, so there's nothing to race against. Fixed with the same shape of guard: a
  `latestKeyRef` tracks the current week's key, and `load()` captures the key it was called with
  and discards its own response if a newer week's request has since superseded it — no abort
  controller needed, since the stale response still resolves fine, it's just ignored. **Lesson
  reinforced: any hook that re-fetches on a changing key with no cancellation/staleness check is
  this exact bug waiting to happen — grep for other `useEffect`/`useCallback`-driven fetches in
  this codebase that key off `weekStart`/`weekOffset`/similar without a matching guard before
  assuming `useActivities.ts`'s v1.321.0 fix was the only place this pattern existed.**
- **World-map watermark: real fix for the "doesn't cover a long page" bug + How to Use content
  expansion (v1.368.0)** — two independent asks from the same round of feedback, both against the
  new-that-week How to Use ImpactIQ page. (1) The watermark div (`/world.webp`, present on Guide,
  How to Use, Admin, and My Settings — see this exact watermark's own repeated history at
  v1.331.0/v1.331.1/v1.349.3/v1.355.0) still went flat/un-tinted below a certain point on any page
  long enough to scroll, reported directly with a screenshot of the How to Use page (the longest
  page in the app, and the newest, so the first to expose it clearly). Root cause, finally
  correctly diagnosed: `absolute inset-0` on the watermark div only ever stretches to the
  CONTAINING BLOCK's own CSS height — and the containing block here is the scroll container itself
  (`relative flex-1 overflow-y-auto`), whose height is the fixed, viewport-sized box `flex-1`
  resolves to, NOT the taller `scrollHeight` the actual content grows to. Every previous pass at
  this watermark (all four prior version bullets above) tuned `background-position`/
  `background-size` on that same absolutely-positioned div and never touched this — the real
  defect was the POSITIONING MODEL, not the image's own sizing math, which is why `cover` alone
  could never have fixed it. Fixed by switching to a single-cell CSS Grid overlay: the scroll
  container's direct child is now `grid grid-cols-1`, with the watermark div and the real content
  div both placed at `col-start-1 row-start-1` (removing the watermark's own `absolute`/`inset-0`
  entirely). Grid's default `align-items`/`justify-items: stretch` sizes every item in a row to
  that row's own height, which is set by its TALLEST item — the real content column — so the
  watermark now always matches actual content height instead of the viewport, with no JS and no
  `scrollHeight` measurement needed. Paint order (content over watermark) is unchanged, since
  same-z-index grid items still stack in DOM order and the content div is still the later sibling.
  Applied in lockstep to all four pages (`Guide.tsx`, `HowToUseImpactIQ.tsx`, `Admin.tsx`,
  `Settings.tsx`) — same structural change, same class names, so the four can't drift again.
  **Verified this time, not just reasoned about** — per this watermark's own standing "requires a
  live check at a wide AND a narrow viewport before shipping" rule (v1.349.3), a static HTML
  harness was built from the real compiled Tailwind output (`npm run build`) and driven headlessly
  (Chromium) at 1600px and 900px, light and dark, scrolled to the bottom of 40 filler sections —
  confirming the watermark texture reaches the very bottom of the scrolled content in all four
  combinations, with no seam and no z-order regression. (2) The How to Use ImpactIQ page (§ v1.367
  footer) gained six content fixes/additions from direct user feedback after reading it closely:
  the Salesforce section wrongly described only a 2-tab Opportunity/Account picker — corrected to
  all 4 real tabs (`SfSearch.tsx`: Opportunity/Account/Lead/Campaign), with the actual Salesforce
  rollup rules (Campaigns roll up via their linked Opportunity; Leads roll up only once converted)
  pulled from `SfRelationshipHelp.tsx`'s own existing copy rather than re-derived; a new "When a
  Salesforce link breaks" subsection distinguishes the two real failure modes — the linked
  What/Who/Related record being deleted (§7's "Activities Disconnected from SF," auto-detected,
  badge-driven) versus ImpactIQ's own written-back SF Event/Task being deleted directly in
  Salesforce (undetected by that feature — surfaces only as a CRM Sync Issue on the next write
  attempt, confirmed by reading `writeback.ts`'s update-path error handling); a new Contributor-
  workflow subsection covers the Outlook-meeting-deleted review queue (§10) the user specifically
  asked to have documented; Subtypes are now explained as a save-blocking requirement when a
  team has them enabled (§7/v1.335.0), with a pointer back to the Guide page's own per-type
  Subtype chips; a Remote-vs-On-site subsection explains the Incidental Costs panel and honestly
  notes those figures aren't wired into cost dashboards yet (matching the Roadmap's own CloudLAB/
  travel-spend banner caveat); and two entirely new top-level sections, **Team Scheduling & Free
  Time** and **My Notes**, were added (icons `CalendarClock`/`NotebookPen`, matching `nav.tsx`'s
  own icons for those pages exactly) — Scheduling's write-up covers the Common/Per User/PTO panel
  modes and the plain-Contributor anonymization rule (`canName = privileged || isSelf` in
  `routes/scheduling.ts`); My Notes' write-up covers the Show-all-teammates'-notes toggle, the
  Private-note visibility rule, and the "Ask My Notes" panel (confirmed scoped to the caller's OWN
  notes only, `eq(activityNotes.createdBy, callerId)` in `routes/ai.ts`, regardless of that
  toggle). **A pre-existing i18n content bug found and fixed while extending `settings_body`**:
  the My Settings group-name bullets ("Connections," "Preferences," "Data & Templates," "Security
  & Access," "Work & Notifications") were hardcoded in English in ALL SIX non-English `how_to_use`
  locale files, never matching the actually-translated `settings.group.*` labels a user sees in
  their own running UI (e.g. German's real sidebar says "Verbindungen," not "Connections") — fixed
  in the same pass across de/fr/es/ja/pt/it. **A second, narrower pre-existing gap found in the
  same area**: `sf_relationship.opportunity`/`.campaign`/`.lead`/`.footnote` (the Account-
  relationship help popover, §9-adjacent `SfRelationshipHelp.tsx`) held literal, stale English
  text in `de`/`fr`/`ja` specifically — es/pt/it were already correct — fixed to real translations
  matching each locale's own already-correct sibling keys' terminology. All new/changed content
  translated with real language per locale (not the `t(key,'English default')` fallback),
  following each locale's own already-established terminology precedent rather than a blanket
  rule: the literal rendered Salesforce tab label where a tab is being named (e.g. `es`:
  "Prospecto," `fr`: "Piste" — confirmed via `sf.lead`), but each locale's own established
  flowing-prose word choice elsewhere (e.g. both `es` and `fr` say "Leads" in running text despite
  the tab itself reading differently, matching `sf_relationship.lead`'s own precedent). `python3
  scripts/check-i18n-parity.py` confirms zero missing/extra keys across all 6 non-English locales
  (3091 keys each); `npx tsc -b --force` (client), `npx tsc --noEmit -p tsconfig.server.json`
  (server), and the full `npx vitest run` suite (191 tests) all pass clean.
- **Watermark v1.368.0's grid fix was itself wrong: stretching distorts the image — reverted to
  the original crop + a plain fill color instead (v1.368.1)** — reported immediately, with
  screenshots of Guide and Login History, once v1.368.0 shipped: the world-map graphic itself now
  looked visibly larger/zoomed-in and cropped differently than before, not just "fixed to reach
  the bottom." The v1.368.0 grid-cell approach was diagnostically correct about WHY the gap
  existed (an absolutely-positioned `inset-0` child is sized by its containing block's own CSS
  box, not the scrollable content's taller `scrollHeight`) but wrong about the fix: stretching
  that same div's height via CSS Grid `stretch` to match the full (much taller) content height
  also changes what `background-size: cover` computes at that height — `cover`'s scale factor is
  height-driven, so a 5×-taller box scales the image 5× larger, visibly zooming in and
  re-cropping it compared to its original, viewport-sized appearance. The two symptoms (image
  looks stretched at the top; still nothing/blank past a certain scroll point on the Guide
  screenshot) both point at the same root cause. **Fixed by treating this as two separate needs
  instead of one mechanism**: (1) the watermark div goes back to exactly its pre-v1.368.0 form —
  plain `absolute inset-0` with the same `background-size: cover`/`right center` position it
  always had, so its rendered crop/zoom is untouched and identical to every prior working
  version; (2) the actual "long page" gap is closed by giving the SCROLL CONTAINER itself (not
  the watermark) a plain `bg-gray-100 dark:bg-gray-900` — one step off the app's own
  `bg-gray-50`/`dark:bg-gray-950` page background (`App.tsx`'s `PageShell`) — since an ordinary
  element background-color always paints across an element's FULL scrollable content area
  (`scrollHeight`), not just its own CSS box height, unlike an absolutely-positioned child. This
  means the image renders at its original, un-stretched size near the top of the scroll (exactly
  as it always looked), and past wherever the image's own box ends, the matching gray tone
  continues seamlessly rather than reverting to a mismatched flat white/black patch. No JS, no
  grid, no `scrollHeight` measurement — reverted in lockstep across all four pages (`Guide.tsx`,
  `HowToUseImpactIQ.tsx`, `Admin.tsx`, `Settings.tsx`) that share this exact watermark div.
  **Re-verified with the same headless-Chromium-against-real-compiled-CSS harness used for
  v1.368.0** (rebuilt after this change, since the CSS changed materially) at 1600px and 900px,
  light and dark: the image at the top of a long scroll now visually matches its original,
  pre-v1.368.0 crop, and the bottom of a 40-section scroll shows the flat fill color cleanly with
  no seam and no stretched/distorted graphic — confirming the fix does what was actually asked
  this time, not just what seemed structurally elegant. **Lesson for this specific watermark div,
  now underscored a sixth time (v1.331.0/v1.331.1/v1.349.3/v1.355.0/v1.368.0/this one): a fix that
  changes the SIZE of the box `background-size: cover` is computed against will change what the
  image looks like, even if the fix's own stated goal is unrelated (here, "reach further down");
  always re-screenshot the TOP of the page too after touching this div's sizing, not just the
  part that was reported broken.** Also fixed in the same pass, per direct follow-up feedback: the
  How to Use ImpactIQ page's content wrapper had its own `mx-auto max-w-4xl` constraint, narrowing
  its cards to a centered ~896px column while every other page in the app (Guide, Admin, Settings,
  Dashboard, etc.) renders its content at the full width of the `p-6`-padded scroll container with
  no such cap — removed to match `Guide.tsx`'s own plain `relative flex flex-col gap-6` exactly,
  so the new page's card widths and left/right margins now agree with the rest of the app instead
  of looking narrower and off-center.
- **Pending Outlook-deletion title turns red on the day-list card; required-field asterisk fully
  red (v1.369.0)** — two small direct UI fixes from the same feedback round. (1) An activity still
  awaiting a Keep/Delete decision (§10) already had its own card in the "This Week's Deleted
  Activities" review section, but the SAME activity's card in the ordinary day list below gave no
  visual signal anything was wrong — a user could easily miss that the meeting they're looking at
  further down the week is the one needing attention. `ActivityCard.tsx` now renders the title in
  red (`text-red-600 dark:text-red-400`) whenever `outlookDeletedAt` is set and `outlookDeletedKept`
  is still false — the identical "pending, not yet decided" flag §10's v1.363.0 month-heatmap/
  week-header dots already read — with a matching hover tooltip. (2) The Log/Edit Activity drawer's
  "Fields marked with * are required" note (§14b-adjacent, `ActivityForm.tsx`) had a decorative red
  `*` icon in front of the sentence, but the literal `*` INSIDE the translated sentence text itself
  rendered in plain gray — so only one of the two asterisks visible on screen was actually red.
  Fixed by splitting the (possibly-translated) string on its own `*` character and wrapping just
  that character in the red span, rather than hardcoding an English string position — works
  identically for every locale's own asterisk placement. New `activity.outlook_deleted.title_hint`
  i18n key, translated in all 7 locales.
- **90-day edit-lock message + App Admin override made explicit; How to Use overview rewritten,
  em dashes removed throughout (v1.370.0)** — three direct requests from the same feedback round.
  (1) §7's 90-day free-edit window (`ActivityForm.tsx`'s `isReadOnly`) previously just silently
  disabled every field with no explanation — a contributor opening an old activity had no way to
  tell why it wouldn't accept edits. New `isPastEditWindow` flag (age > 90 days, independent of
  role) drives an amber banner at the top of the drawer whenever it's true: for a non-App-Admin it
  reads "can no longer be edited... only an App Admin can edit an activity of any age"; for an App
  Admin viewing the same aged record it instead confirms they CAN edit it because they're an App
  Admin. `isReadOnly` itself is now `isPastEditWindow && !currentUser?.isAppAdmin` — previously
  App Admins had no documented or actual exemption from this lock at all (§5 only ever said Team
  Leaders/Team Admins can't edit contributor records, never addressed the age lock for anyone);
  this both documents and implements the exemption App Admin's global-access role implies. New
  `activity.form.past_edit_window_readonly`/`.past_edit_window_admin_override` i18n keys,
  translated in all 7 locales. (2) The How to Use ImpactIQ page's (§18 v1.367.0) "What is
  ImpactIQ?" overview section, above the four-roles list, was rewritten per explicit provided
  copy: it now frames ImpactIQ as a revenue-capacity intelligence platform, states the core
  problem (capacity is invisible) and the solution (contributor-first logging anchored to Outlook,
  Salesforce as system of record, dashboards derived from real logged activity, multi-team
  architecture), and lists the five leadership questions its business case should answer. The
  "capacity planning tool, not a performance review tool" note and the four-roles list underneath
  are unchanged in substance, just re-punctuated per (3) below. (3) Every em dash used as a
  mid-sentence phrase separator across the entire `how_to_use` namespace (all 11 body/subtitle
  keys, en locale) was replaced with the punctuation actually suited to that clause — a colon
  after a bold term introducing a definition (list items like "**Capacity**: team heatmap..."), a
  semicolon joining two independent clauses, a parenthetical for an aside, or a full stop where the
  em dash was really joining two separate sentences. The hyphen-led Markdown list bullets
  themselves (`- **Term**...`) are untouched — this only ever affected the em dash punctuation
  mark, never the list structure. **Process note**: the first two batch-replacement passes each
  silently applied ZERO changes despite printing "applied OK," because the apply script's own
  logic aborted the whole batch write whenever ANY single pair in that batch failed its exact-match
  check (a `\"` vs `\\"` JSON-escaping mismatch on a few entries) — the exact "always re-verify a
  translation batch by re-scanning for gaps after writing, not by trusting the apply script's own
  reported count" lesson this file's own v1.325.0 note already flags, recurring in a fresh script.
  Caught by re-scanning for stray `—` characters after each pass rather than trusting the first
  script's own printed success; the other 6 locales' `how_to_use` content was not touched by this
  pass (out of scope — the request was specifically about the English "How to Guide" prose).
- **Vendor-neutral genericization + configurable Support Email (v1.371.0)** — the app must be
  generic, with no company-specific names anywhere. Every hardcoded company name, hostname, and
  example value was removed from UI placeholders (Setup wizard, Admin → Integrations), code
  comments, docs (README, PRD, `docs/*.md`), `.env.example`, and all 7 locale files (including
  each locale's `how_to_use.overview_body`, which still carried the old pre-v1.370.0 English-derived
  "the company's internal tool" wording). Structural changes: (1) the Login/Setup/ForgotPassword/
  ResetPassword help icon and the in-app header help icon used a hardcoded `mailto:` to one
  company's team inbox; both now read an admin-configured **Support contact email**
  (`system_settings` key `support_email`, `SUPPORT_EMAIL` env fallback — same DB-preferred pattern
  as `getPublicBaseUrl`). Admin GET/PUT at `/api/admin/integrations/support-email`
  (`requireAppAdmin`), edited from a `SupportEmailField` under Admin → Themes; read pre-auth via
  the genuinely-public `GET /api/themes/support-email` (mounted before the `/api` auth gate, like
  `/api/themes/active`). `AuthShell.tsx` fetches it directly; the authenticated `PageHeader` reads
  a shared `useSupportEmail()` store populated once by `App.tsx` so every page doesn't re-fetch.
  **Unset hides the icon entirely** — no placeholder address is ever linked. (2) `DEFAULT_INTERNAL
  _DOMAINS` (SF attendee internal-domain filter) defaulted to one company's domain; now empty.
  (3) Migration 0149 (frozen, never editable) seeds the fresh-install default theme under a
  company-specific name, so migration `0152_generic_default_theme_name.sql` renames it to
  "Default" (idempotent; only touches a row still carrying the old seeded name). The
  `promotePaletteToTheme.test.ts` fixture that exercises that legacy name is intentionally
  retained, since it is the literal input 0152 must match. (4) Historical entries in this file and
  `changelog.ts` now say "Acme Brand"/"Brand Palette" and "a reference/production org" instead of
  the real names, preserving the narrative and measurements. New i18n keys
  `admin.integrations.support_email.*` (label/hint/placeholder/failed) translated in all 7
  locales; `login.help_email_hint` reworded from a specific team to "support".
- **App-wide Login screen logo (v1.372.0)** — Admin → Themes gains a standalone **Login screen
  logo** card (outside the theme editor, since no team theme applies before sign-in) for the large
  graphic `AuthShell.tsx` renders above the sign-in card on Login/Forgot/Reset Password. Stored as an
  image data URI in `system_settings` (key `login_logo`, no migration needed — same key-value pattern
  as `support_email`), written via `PUT /api/admin/integrations/login-logo` (`requireAppAdmin`,
  validated with the same `validateLogoDataUrl()` MIME allowlist + size cap as theme logos, a
  non-empty invalid value is rejected with `errors.themes.invalid_login_logo` rather than silently
  cleared; audited as `integration.login_logo.save`/`.clear`), and read pre-auth via the public
  `GET /api/themes/login-logo`. `AuthShell` uses it first and falls back to the active theme's
  dark → light logo exactly as before, so an install that never sets it is unchanged. Nothing is
  seeded: no vendor graphic ships by default.
- **Login screen logo display size (v1.373.0)** — the v1.372.0 login logo rendered at a fixed
  9rem height, which read as far too small for a wide logo with internal padding. It now has an
  admin-set **Display size** (width/height in px, Admin → Themes → Login screen logo), stored as
  optional `width`/`height` alongside `dataUrl` in the same `login_logo` `system_settings` row
  (partial-update PUT, so resizing never touches the image and replacing the image keeps the
  size; resizes are audited as `integration.login_logo.resize`). Either dimension left blank
  defaults by the uploaded image's own shape (`src/shared/loginLogoSize.ts`): roughly square
  (aspect 0.85–1.18) gets a 250×250 box, anything else 750×200. The size is a bounding box
  (`object-fit: contain`, never stretched) capped at `max-width: 100%` / `max-height: 35vh` for
  narrow and short screens. The login logo now renders in normal flow above the card (the old
  absolute `top: 12vh` placement would overlap the card at these sizes); the active-theme
  fallback, used when no login logo is set, keeps its original placement and size. Browser-
  verified at desktop and phone widths for a wide, a square and a custom-sized logo.
- **Activity Types Export / Import (v1.374.0)** — see §14's Activity Types bullet. Lets an admin
  back up a team's whole Activity Types setup and load it into another team or a new install.
  Audited as `activity_type.import` (one flat-summary row per apply). Covered by
  `activityTypesTransfer.test.ts` (pglite: export shape, round-trip into an empty team with a
  second import being a no-op, upsert-by-name, subtypes kept, extras replaced, one default star,
  shared-type skip, and full rollback when a write fails part-way).
- **Full database Backup & Restore (v1.375.0)** — see §14d. Admin → Monitoring & Audit →
  Backup & Restore (App Admin only) exports the entire application database to one gzip'd
  file and restores it into another install, for moving ImpactIQ to a new server or keeping
  an offline copy. Environment variables and secrets are deliberately not included; each
  install keeps its own. Import previews the file first (row counts per table, schema-version
  match, App Admin accounts present, encryption-key fingerprint, whether the importing admin
  is in the backup), then restores only after the admin types `RESTORE`, in one transaction
  that rolls back completely on any failure. Every export, restore and failed restore is
  audited (`system_backup.*`; `restore` is in `DESTRUCTIVE_AUDIT_ACTIONS`). New
  `BACKUP_MAX_UPLOAD_MB` env var (default 2048). pglite round-trip tests
  (`services/backup/backup.test.ts`) plus a manual end-to-end run between two real
  Postgres 16 databases (970 demo activities, every table byte-identical after restore).
  **Found along the way, not fixed here**: running the full migration history against an
  EMPTY real Postgres via the server's own boot-time migrator fails with `unsafe use of new
  value "team_admin" of enum type role` (an `ALTER TYPE ... ADD VALUE` used in the same
  transaction) — the same pre-existing issue v1.331.0 noted. pglite's simple-query replay
  hides it.
- **Default icons and icon colors for the seeded Activity Types (v1.376.0)** — the ten default
  types (Demo, Discovery, Enablement, Eval Work, Executive Briefing, HealthCheck, Marketing,
  Meeting, RFx Work, Support) were seeded with no `icon`/`color`, so a fresh install showed a
  plain list. One shared map, `src/shared/defaultActivityTypeStyles.ts` (lucide component name
  + hex color per type name), now feeds all three places defaults come from: `drizzle/seed.ts`
  (fresh install), `applyDefaultTeamConfig()` (new team), and Admin → Activity Types → Seed
  Default Content (`POST /teams/:teamId/seed-guide-content`), which fills icon and color only
  where a type has none, never overwriting an admin's pick, same fill-only-blanks contract as
  its Guide fields. Name-matched, so a renamed or custom type is left alone. Covered by
  `defaultActivityTypeStyles.test.ts` (every icon name exists in lucide-react; a new team gets
  all ten styled).
- **Guide lists every active Activity Type with its icon + existing installs backfilled (v1.377.0)** —
  The owner reported the Guide showing no icons. The page already rendered `icon`/`color` from
  `team_activity_types`; the installed rows were simply blank, since v1.376.0 only styled new
  installs/new teams and needed a Seed Default Content click on existing ones. Migration
  `0153_default_activity_type_styles.sql` now fills blank icon/color on the ten default-named types
  (never overwriting an admin pick, custom types untouched), and the Guide now shows a card for
  every active type except Meeting, even before its Guide text is filled in, so a newly added type
  appears right away. Migration covered in `defaultActivityTypeStyles.test.ts`.
- **Login logo fills its box and no longer pushes the card down (v1.377.1)** — reported after
  v1.373.0 with a 750×200 size set: the logo still looked small and sat lower than before. Two
  causes. (1) The uploaded PNG carried its own wide band of dark-blue gradient background around
  the artwork, and with `object-fit: contain` that padding scaled along with it, so the visible
  artwork was ~300×85 inside the 750×200 box. New `src/client/lib/trimImage.ts`
  (`trimImageDataUrl()`) crops it at render time: background is estimated per pixel by bilinear
  interpolation of the four corner colors (covers transparent padding, a flat fill, and a linear
  gradient), rows/columns need several differing pixels to count (ignores JPEG noise), a 3% margin
  is kept, and an opaque background is then faded out with a soft matte so no rectangle shows
  against the page. SVGs and images with little border are returned unchanged; any failure falls
  back to the original. Applied in `AuthShell.tsx` and the Admin → Themes preview (so the
  shape-based default size is computed from the trimmed image), never written back to storage, so
  existing uploads are fixed without re-uploading. (2) v1.373.0 put the logo in flow above the
  card and centered the pair, which moved the card down. The card is centered on its own again and
  the logo is absolutely positioned just above it, its height capped at
  `min(configured, (100vh - cardHeight) / 2 - 3rem)` (card height via `ResizeObserver`), so it
  shrinks on short screens instead of overlapping. Browser-verified with a padded gradient PNG, an
  SVG, and 1720×987 / 1366×620 / 390×800 viewports.
- **Login logo no longer jumps in size while the page loads (v1.377.3)** — reported after
  v1.377.1: the logo showed smaller for about a second, then grew to its configured size. Cause:
  `AuthShell.tsx` treated "login logo not fetched yet" the same as "no login logo set", so the
  active theme's logo (9rem tall, untrimmed, often the same artwork) rendered in its place until
  `GET /api/themes/login-logo` answered with the larger data URI, then got swapped. `loginLogo` is
  now `undefined` while loading and the theme fallback only renders once it is `null`. The login
  logo also waits for the card to reach its final height before appearing: Login passes
  `contentReady` until both SSO provider checks answer (the SSO button changes the card's height,
  which changes the logo's height cap on short screens), then the card must hold one height for
  250ms. Once shown it stays shown. Reproduced and verified in a Playwright frame trace with
  delayed API responses and CPU throttling at 987/760/620px viewport heights.
- **Admin header spans the full width, sub-nav sits below it (v1.378.0)** — on every Admin page
  the second-tier Admin menu column used to run the full page height, with the page header
  (title, team picker, quarter pill, bell) only above the content area. `Admin.tsx` now renders
  `<PageHeader>` first, across the full width starting at the main sidebar's edge, and puts the
  Admin menu and the content side by side in a `flex min-h-0 flex-1` row below it. The menu's
  own scrolling, category expand/collapse, and the world-map watermark are unchanged.
- **Theme presets aligned with VectorIQ (v1.379.0)** — Admin → Themes' preset row
  (`theme-presets.ts`) now leads with VectorIQ's 12 presets in VectorIQ's order (Midnight Slate,
  Warm Neutral, Forest Green, Ocean Blue, Purple, Darker Purple, Sunset Coral, Dark Blue, Dark
  Purple, Dark Green, Gray, Dark), with the ImpactIQ-only Dark Yellow, Teal and Crimson after.
  Sidebar, topbar (`header*`), accent, nav and user-pill values are copied from VectorIQ's
  `client/src/lib/theme-colors.ts`. VectorIQ themes only the chrome, so each preset's page-level
  fields (surface, page bg, border, link) keep ImpactIQ's prior values for that key (Darker Purple
  borrows Purple's, Dark borrows Gray's); header text is checked for 4.5:1 against both topbar
  stops and swapped to plain ink if it fails; `sidebarTextMuted*` takes the user-pill subtitle
  color. Dark Blue / Dark Purple / Dark Green / Dark keep a dark sidebar in BOTH modes, so a team
  already saved on an old version of those presets is unchanged (presets only fill the editor).
  The chips switch to VectorIQ's look (light sidebar, dark sidebar, button-color dot) with the
  caption "Shown: light-mode sidebar, dark-mode sidebar, and the button color." Also fixed:
  `button.tsx`'s primary variant hardcoded `text-white`, which was unreadable on Gray's existing
  dark-mode primary (`#E5E5E5`) and would be on Dark's (`#F4F4F5`); `applyThemeColors()` now sets
  `--color-primary-fg-light/-dark` from `readableTextOn()` (`src/shared/readableText.ts`): white
  unless white falls under 2:1 on the button color, then dark ink, so mid-tone themes look exactly
  as before (VectorIQ picks the higher-contrast ink outright; ImpactIQ deliberately doesn't, to
  avoid flipping existing dark-mode buttons). White fallback when unset.
- **Sidebar collapse button matches VectorIQ (v1.379.1)** — the round chevron that sat on the sidebar's edge is replaced with VectorIQ's toggle, copied from its `client/src/components/layout/sidebar.tsx`: expanded, a `PanelLeftClose` icon button inline in the header to the right of the wordmark; collapsed, a `PanelLeftOpen` round badge (`absolute -right-3 top-6`, sidebar top-gradient fill + sidebar border) overlapping the logo's corner. Colors use the existing themed sidebar text / nav-hover / border variables. The title is now translated (`nav.expand_sidebar` / `nav.collapse_sidebar`, all 7 locales); it used to be hardcoded English.
- **Sidebar width and icon sizes match VectorIQ (v1.379.2)** — the collapsed sidebar goes from `w-14` (56px) to VectorIQ's `w-20` (80px including the 1px border), the collapsed logo from 32px to 40px, and every sidebar icon (nav links, settings/logout/update buttons, the collapsed team selector and SF/Outlook status icons) from 16px to VectorIQ's 20px (`h-5 w-5`). The expanded width (`w-56`) is unchanged; VectorIQ's is `w-64`.
- **Collapsed-sidebar status icons centered + "CRM not configured" (v1.379.3)** — `NavConnectBtn` (`sf-connect-button.tsx`) kept its expanded `px-3 gap-2` left-aligned layout when collapsed, so the Salesforce and Outlook icons sat left of center in the 80px rail; collapsed now uses `justify-center px-0`. `sf.connect.not_configured` reads "CRM not configured" in all 7 locales, since the button will front other CRMs (HubSpot) later; the connected/connect labels still name Salesforce.
- **Page header title matches VectorIQ (v1.380.0)** — `PageHeader` (`page-header.tsx`, shared by every page) now copies VectorIQ's `topbar.tsx` title row: icon `h-5 w-5` (20px, was 16px), title `text-lg font-bold tracking-tight` (18px bold, was 16px semibold), description a separate `text-sm` muted line (`#4B5768` light / `#94A3B8` dark, VectorIQ's `muted-foreground`), hidden below `md`, prefixed with `— `; title and description truncate. The icon color is a new theme field, `pageHeaderIconLight`/`pageHeaderIconDark` (VectorIQ's own field name), editable in Admin → Themes as "Page title icon" and declared in the server's `themeColorsSchema` (§18 v1.358.1's Zod-strip lesson). `applyThemeColors()` sets/removes `--color-page-header-icon-light/-dark`; unset falls back to the theme's primary color, then blue. The 12 VectorIQ presets carry VectorIQ's exact values; Dark Yellow/Teal/Crimson use their own accent. VectorIQ's `Outfit` heading font was not brought over (ImpactIQ loads no web fonts).
- **Sidebar wordmark and header dash aligned like VectorIQ (v1.380.1)** — the sidebar name/version column is now exactly the logo's height (`h-8 flex-col justify-between`), the name `text-xl font-bold leading-none tracking-tight` so its top meets the logo's top and the version sits at the logo's bottom; the old `leading-tight` name plus the version chip's inline line-height strut made the column taller than the logo and spread them apart (`VersionChip`'s wrapper is now `flex leading-none`). The page-header description's dash is a drawn `h-px w-3.5 bg-current` line centred by flex instead of an em-dash glyph, since Windows' Segoe UI draws `—` low, making the description look higher than the dash.
- **shell-quote critical alert fixed by bumping concurrently (v1.380.2)** — Dependabot alert #30: `shell-quote` 1.9.0 (command injection, fixed in 1.11.0) came in only through the dev dependency `concurrently@9.2.4`, which pins it exactly, so Dependabot couldn't bump it alone. `concurrently` 9.2.5 pins `shell-quote` 1.12.0, so the fix is a same-major bump (`^9.2.5`), no `overrides` entry. Dev-only (used by `npm run dev`), never in the production image. `npm audit`: 0 vulnerabilities; `npm run dev` starts both workspaces.
- **Browser tab title (v1.380.3)** — `src/client/index.html`'s `<title>` reads "ImpactIQ | Activity to Impact" instead of just "ImpactIQ".
- **App-wide Campaigns switch, first HubSpot groundwork (v1.381.0)** — Phase 1a of the HubSpot plan (an install-wide either/or alternative to Salesforce; the plan is a Claude Doc, see project memory `hubspot-integration-plan`). New `system_settings` key `crm_features` (`{campaignsEnabled}`, default `true`, no migration) read through `services/crm/features.ts` (`getCrmFeatures()`, 30s cache, cleared on write and after a backup restore) and shared helpers in `src/shared/crmFeatures.ts`. Admin → Integrations → **CRM features** card (`CrmFeaturesCard.tsx`, App Admin, `GET`/`PUT /api/admin/integrations/crm-features`, audited `integration.crm_features.update` with `{before, after}`); any signed-in user reads it via `GET /api/crm/features` into the `useCrmFeatures()` store. Off means: the Campaign tab in `SfSearch` is hidden, `/api/salesforce/search/campaigns` returns 403 `errors.crm.campaigns_disabled`, Most Expensive drops its Campaigns scope, Team-of-Teams Rollup drops its Campaigns column, and the Account include-all and note-entity Campaign SOQL lookups are skipped. **Enforced server-side, not just hidden**: `POST`/`PATCH /api/activities` reject a new or changed Campaign link (`isBlockedCampaignLink()`), but an activity already linked to a Campaign keeps that link on save, so turning the switch off never strands or rewrites existing data. Built CRM-neutral on purpose: the same switch will gate HubSpot Marketing Hub campaigns once HubSpot lands. Tests: `crmFeatures.test.ts` (blocking rule) and `services/crm/features.test.ts` (pglite round-trip).
- **App-wide Leads switch (v1.382.0)** — the owner asked whether the v1.381.0 Campaigns switch covered Leads; it didn't, so a second switch now sits on the same Admin → Integrations → CRM features card. `crm_features` gains `leadsEnabled` (default `true`, same `system_settings` row, no migration; a stored row without the key reads as on). Leads live in the Who slot (`sfWhoType = 'Lead'`), so the blocking rule is a sibling, `isBlockedLeadLink()`, and both rules are combined by `blockedCrmLinkError()` (`src/shared/crmFeatures.ts`), which `POST`/`PATCH /api/activities` use to return 403 `errors.crm.campaigns_disabled` or `errors.crm.leads_disabled`. Same keep-existing-links contract as Campaigns. Off also means: `/api/salesforce/search/leads` returns 403, the Lead tab in `SfSearch` and the Lead line in `SfRelationshipHelp` are hidden, Most Expensive drops its Leads scope, Team-of-Teams Rollup drops its Leads column, and the account drill-in skips the converted-Lead SOQL lookup. Dashboards that only break down already-saved rows (Account / Opportunity Concentration, the SF Activities modal breakdown, My Notes' Lead bucket) still show existing Lead data. `CrmFeaturesCard.tsx` now renders one row per switch from a small list, so a third switch is one more entry.
- **CRM provider layer, HubSpot phase 1b (v1.383.0)** — see §9's new "CRM provider layer". An install-wide
  `crm_provider` setting (Salesforce by default, no UI yet) and a `CrmProvider` interface with Salesforce behind it as a
  thin adapter. Salesforce search, the hover preview, activity write-back and the snapshot refresh now go through it,
  with no behavior change for Salesforce users (proven by a test comparing the SOQL sent through the provider with the
  direct calls). When the setting names another CRM, `/api/salesforce/*` answers 409 `errors.crm.provider_mismatch`
  (new key, all 7 locales) and the Salesforce scheduled jobs stand down.
- **Choose the CRM + lock, HubSpot phase 1c (v1.384.0)** — see §9's "Choosing the CRM + the lock". Setup wizard step 6
  and a new Admin → Integrations → CRM card choose Salesforce or None (HubSpot listed as coming soon). Once anything
  links to CRM records the install is locked to that CRM (switching to None and back stays allowed). With Salesforce not
  active, Salesforce reads as not configured everywhere. First provider-aware labels (Deal/Company for HubSpot) via an
  i18next context. New keys in all 7 locales; `providerLock.test.ts` (pglite) covers the lock.
- **Projects (Evaluations) source + CriteriaIQ connection, HubSpot phase 1d (v1.385.0)** — see §9's new bullet. An
  install-wide Project source setting (CRM object today; CriteriaIQ and Off stored but "coming soon") locked once activities
  link to Projects, a CriteriaIQ connection with an encrypted API key and a Test button, and a read-only CriteriaIQ client
  with an admin lookup of CriteriaIQ projects by Salesforce Evaluation id. New keys in all 7 locales; tests cover the lock
  (pglite), the client (mocked fetch) and the new URL guard.
- **CriteriaIQ secondary panel on the activity drawer (v1.386.0)** — see §9's new bullet. "Use CriteriaIQ as a secondary
  source" is now selectable; with it on, a linked Project shows its CriteriaIQ project (criteria progress, status, link
  out), auto-linked when exactly one CriteriaIQ project points at the Evaluation, otherwise chosen once per Evaluation
  (new `criteriaiq_evaluation_links` table, migration 0154), with CRM/CriteriaIQ disagreements flagged, not resolved.
  New keys in all 7 locales; pglite tests for the link rules, unit tests for the mismatch check and criteria counting.
- **Project source card renamed "Projects (POC|POV)" (v1.386.1)** — the owner's wording for what the card governs; the title changed in all 7 locales, nothing else.
- **Projects can be turned Off (v1.387.0)** — see §9's "Projects Off". The Off choice on Admin → Integrations → Projects
  (POC|POV) is now offered: it hides the Project picker, Project chips and panels, Engineer Notes posting and the Won w/o
  POC / Project-Specific Costing dashboards, refuses new Project links on the server, and pauses the Project parts of the
  nightly snapshot refresh. Saved links are kept. New keys in all 7 locales; tests cover the link-blocking rule and the
  route guard (pglite).
- **CriteriaIQ as the primary Project source (v1.388.0)** — see §9's "CriteriaIQ as primary". Once CriteriaIQ is
  connected, Admin → Integrations → Projects (POC|POV) can make it the primary source: Project pickers list CriteriaIQ
  projects (suggested by Opportunity name, plus search), the server snapshots the picked project on save, a nightly job
  refreshes linked projects, and Won w/o POC checks CriteriaIQ. Engineer Notes posting is off under it. New keys in all
  7 locales; pglite tests for the save check, the nightly refresh, the Won w/o POC lookup and the `requireCrmProjects()`
  guard.
- **HubSpot connection + owner matching, HubSpot phase 2a (v1.389.0)** — see §9's new bullet. Admin → Integrations
  gains a HubSpot connection card: paste a private app token (checked with HubSpot, stored encrypted), run an access
  check that lists each capability and the scope that grants it without touching HubSpot data, and copy the portal's
  owners so users are matched to HubSpot owners by email. Adds `hubspot_owners` (migration 0155), the daily
  `hubspot_owner_sync` job, a shared HubSpot API client with a rate limiter, and `errors.hubspot.*` keys in all 7
  locales. Tests: rate limiter (fake clock), client (mocked fetch: 401, 429 retry, daily limit, network), access-check
  classification, and pglite tests for owner sync, email matching, the portal lock and removal. Not yet checked
  against the live test portal (needs network access from the session).
- **HubSpot service keys + live check (v1.389.1)** — the HubSpot connection card's wording now covers HubSpot service
  keys (Development → Keys → Service Keys) alongside private app tokens, in all 7 locales; ImpactIQ sends either the same
  way. Live-checked against test portal 247756533: token save, Check access (ready; leads and campaigns optional and
  missing) and Sync owners all worked. Two fixes from that run: the tickets capability now names the
  `crm.objects.tickets.read` scope (the old private-app name `tickets` doesn't appear for service keys), and the card
  shows the portal's domain when HubSpot returns no portal name.
- **HubSpot card always listed (v1.389.2)** — the owner couldn't find anywhere to enter HubSpot details: the card was
  hidden while Salesforce is the CRM, and HubSpot can't be chosen until phase 2b. The card now always sits right after
  the Salesforce card (or in its place when Salesforce isn't the CRM), laid out like the other integration cards
  (Configured badge, Configure toggle), with a note when Salesforce is still the CRM and a "Scopes to grant" list shown
  before a key is saved. A service key or private app token is the only thing HubSpot needs (no client id, secret or
  redirect URL, since there's no OAuth). Scope names moved to the shared `HUBSPOT_CAPABILITY_SCOPES` map, used by both
  the access check and the card. Browser-checked against a stubbed backend.
- **HubSpot search, previews and write-back + Integrations page regrouped (v1.390.0)** — see §9's "HubSpot provider".
  HubSpot is now a selectable CRM (the owner: "Hubspot still says coming soon in CRM"): Deal/Company/Contact search (Leads
  and Campaigns when the portal has them), Deal/Company hover previews, and meeting/task write-back with associations
  and retry. Built to work on any portal and tier, not tuned to the test portal; Leads and Campaigns are unverified
  live. Admin → Integrations, per the owner's request: the CRM card is now a collapsible group holding the Salesforce,
  HubSpot, admin Salesforce connection and CRM features cards (open by default), and Projects (POC|POV) and Rate
  Limiting are collapsible, collapsed by default, with Active/Inactive and Locked/Unlocked pills in the header (shared
  `CollapsibleCard.tsx`). Tests: `hubspot/search.test.ts` (filters, mapping, associations, optional features) and
  `hubspot/writeback.test.ts` (payload building, plus pglite create/update/404/retry/association-failure and
  junction-scoped mappings). Browser-checked against a stubbed backend in light and dark mode.
- **HubSpot field mappings: pickers + validation, HubSpot phase 2b part 2 (v1.391.0)** — see §9's new bullet. With
  HubSpot as the CRM, the mappings page lists HubSpot objects and live HubSpot properties (labels, types, options,
  read-only marks), and Validate & dry run checks each mapping against the portal and previews the exact meeting/task
  properties a sync would send; Sample record reads one real record. Built for any portal: nothing assumes the test
  portal's properties. Also translated 15 keys on that page that only ever had English fallbacks (Direction, Active,
  field search, object list notes). 19 new tests; browser-checked against a stubbed backend in light and dark mode.
- **AI Assistant: multi-provider AI (v1.392.0)** — see §14's AI Assistant bullet. The owner asked for VectorIQ's AI
  Assistant page with CriteriaIQ's provider flexibility, as groundwork for more AI features. Admin → Integrations → AI
  Assistant connects Anthropic, Azure OpenAI, OpenAI, Bedrock, Foundry, Gemini or xAI, with a master switch, monthly
  budget, usage log and per-feature routing; activity classification, note organize/link suggestions and Ask My Notes
  all run through one gateway. Migration 0156 copies a configured Azure OpenAI row into `ai_providers` as the active
  default, turns the assistant on, and deletes the old row; the `AZURE_OPENAI_*` env fallback is gone (the owner: not needed
  for backward compatibility), so an install that only set those env vars re-enters its provider on the new page.
  Calendar classifications are cached (`ai_classification_cache`, culled after 90 days unused), and `ai_requests` is
  culled after `AI_REQUESTS_RETENTION_DAYS` (395). Tests: `services/ai/gateway.test.ts` (routing, budget + monthly
  email, usage cost, the cache, and the migration copy).
- **AI Assistant usage totals (v1.392.1)** — the owner asked for VectorIQ's usage tiles: the Usage this month card on Admin → Integrations → AI Assistant now opens with Requests, Input tokens, Output tokens and Estimated cost (spent / budget when a budget is set), summed client-side from the existing `month.byProvider` rows (no API change), plus a privacy line and a cost-estimate note. The per-provider table shows only with 2+ providers used this month.
- **Integrations page order (v1.392.2)** — Admin → Integrations now reads Okta SSO, Azure SSO, Microsoft Graph (Outlook), Email Configuration, the CRM section, Projects (POC|POV), Slack, App Updates, Rate Limiting (`BEFORE_CRM_KEYS` in `IntegrationsStatus.tsx` splits `INTEGRATIONS` around the CRM group). The CRM section (`CrmProviderCard.tsx`) now starts collapsed, matching Projects and Rate Limiting.
- **HubSpot Deal snapshot refresh + Deal filters, HubSpot phase 3 (v1.393.0)** — see §9's new bullet. The owner asked for phases 3 and 4; this is phase 3 as its own PR. A nightly job keeps HubSpot Deal stage, forecast, amount, close date, owner, SE and Company current on logged activities, the dashboard Refresh button now runs it, the Deal Stage / Forecast filters list the portal's real stages grouped by pipeline, and TCE By Account works without Salesforce. Live-checked against test portal 247756533 (deal 356553095874 refreshed with its stage, amount, close date and Company). 8 new tests in `hubspot/refreshSnapshots.test.ts`; browser-checked against a stubbed backend in light and dark mode. Removed `errors.hubspot.snapshot_refresh_unavailable`.
- **Tests read the source, not a stale build (v1.393.1)** — imports name the emitted `.js` file, and Vite only maps `./x.js` to `./x.ts` when no `x.js` exists, so a local `tsc` build that left a gitignored `drizzle/schema.js` behind made vitest load that old copy. On a build predating the AI tables, 8 tests in `services/ai/gateway.test.ts` failed with `delete from ` (undefined table). A `prefer-ts-source` resolver in `vitest.config.ts` now picks the sibling `.ts` whenever one exists. No app code changed.
- **HubSpot notes push, Support Tickets, CRM Sync, HubSpot phase 4 (v1.394.0)** — see §9's new bullet. Second half of the owner's "phases 3 and 4". Notes push to a HubSpot Deal or Company, the Support Tickets picker on HubSpot Tickets (no setup needed: standard properties, closed from pipeline stages), HubSpot meeting/task deleted when its activity is deleted, and CRM Sync explaining HubSpot errors in plain words, all in 7 languages. Live-checked against test portal 247756533: a note pushed onto deal 356553095874 and associated, two test tickets on the Company found by Company scope (closed one hidden until Show Closed) and by text; all test records deleted afterwards. New tests: `hubspot/notesPush.test.ts` (7), `hubspot/tickets.test.ts` (10), `deleteHubspotEngagement` (3). Browser-checked CRM Sync issues, the ticket picker and the admin ticket form against a stubbed backend in light and dark mode.
- **Leftover Salesforce wording under HubSpot + AI link suggestions on HubSpot (v1.395.0)** — see §9's new bullet. Start of the owner's "continue on with project" after phase 4. HubSpot installs no longer see "Salesforce" on the activity form, hover preview, deleted-meeting review, Outlook-only hint or My Notes; the preview links to the HubSpot record; My Notes' Find matching records works through HubSpot. Also found and fixed: 33 `admin.activity_types.sf_extras_*` keys and the extras badges/field types had never been translated in any locale (English defaults everywhere). New test `routes/ai.linkSuggestions.test.ts` (2).
- **HubSpot Campaigns + Leads follow the portal (v1.396.0, HubSpot phase 5)** — see §9's new bullet. Campaign and Lead tabs, links and searches now stay hidden on a HubSpot portal whose access check found them missing, with an explanation on Admin → CRM features; a Company's Include All drill-in rolls in its linked Leads; a campaign-linked meeting is added to the HubSpot campaign as an asset. Lead/Campaign search and linking (phase 2b) and the Most Expensive / Team-of-Teams Lead and Campaign scopes (local data) already worked on HubSpot. Also fixed while there: `GET /api/activities/account-drill` trusted `?teamId=` unchecked (any signed-in user could read another team's submitted activities on an Account); it now 403s unless the team is in `getAccessibleTeamIds()`. Tests: 5 new in `services/crm/features.test.ts`, `routes/activities.accountDrill.test.ts` (3), 5 campaign tests in `hubspot/writeback.test.ts`.
- **HubSpot Assigned SE + ACV write-back (v1.397.0, HubSpot phase 6a)** — see §9's new bullet. The activity form's Assigned SE picker used to call the Salesforce routes on HubSpot (409); it now reads and writes the team's mapped `assigned_se_write` Deal property, limited to users matched to a HubSpot owner. An activity's ACV goes onto its HubSpot Deal through a writable `acv` mapping. Fixed while testing: the owner option list first flagged every owner as an ImpactIQ user, because an unqualified `email` in an `EXISTS` subquery resolved to the inner `users` table. Tests: `hubspot/dealFields.test.ts` (11), `routes/crm.assignedSe.test.ts` (6), 3 ACV tests in `hubspot/writeback.test.ts`, deal write checks in `hubspot/mappingValidation.test.ts`.
- **HubSpot Projects (v1.398.0, HubSpot phase 6b)** — see §9's new bullet. On HubSpot, the Project picker, Project panel, Engineer Notes / Next Steps posting, the Project hover preview and the nightly Project refresh used to stop at the Salesforce routes (409); they now run against HubSpot's standard Projects object or a custom object, chosen per Activity Type and driven by the team's `eval_*` mappings. Built from HubSpot's docs and checked live only partly: on test portal 247756533 the Projects object, its properties, the Deal→Project associations read and the write probe all answered as expected, but no Project record could be created there (the object needs a pipeline stage, the portal has no Project pipelines and the service key can't create one), so the read, edit and post paths on a real record are covered by tests only. Tests: `hubspot/projects.test.ts` (15), `routes/crm.projects.test.ts` (8), Project checks in `hubspot/mappingValidation.test.ts`.
- **HubSpot link health, Relink and merges (v1.399.0, HubSpot phase 7a)** — see §9's new bullet. On HubSpot, nothing used to notice a deleted Deal/Company/Contact/Lead/Project, the drawer's link check and Relink stopped at the Salesforce routes, and a merged record would have looked deleted. A nightly job and the drawer's live check now flag only records HubSpot reports as not found, and a merged record moves every activity to the survivor instead (logged as `activity.crm_merge_relink`). Relink works on HubSpot Deals. Checked live on test portal 247756533: a Deal merge (the old id reads back as the survivor) and the batch read's 207 `OBJECT_NOT_FOUND` shape. Tests: `hubspot/linkHealth.test.ts` (12), `routes/hubspotLinkHealth.routes.test.ts` (7), merge cases in `hubspot/refreshSnapshots.test.ts` and `hubspot/projects.test.ts`.
- **HubSpot attendees, Attach Rate and Sales Team Alignment (v1.400.0, HubSpot phase 7b)** — see §9's new bullet. Attendee-based Deal/Company suggestions on calendar cards and the activity form, the Attendees section's contact search, Attach Rate's nightly coverage cache, Sales Team Alignment and the Sales Team Breakdown dashboard now work on HubSpot. HubSpot owners appear in the alignment picker; Salesforce rows already in `sf_users` are kept but hidden. Built from HubSpot docs; the id-paged Deal search was checked live on test portal 247756533. Tests: `hubspot/attendees.test.ts` (8), `routes/crmAttendees.routes.test.ts` (9), `hubspot/attachCoverage.test.ts` (5), `hubspot/recordOwners.test.ts` (3), `routes/salesTeamAlignment.routes.test.ts` (4) and an `sf_users` copy case in `hubspot/owners.test.ts`.
- **HubSpot historical import (v1.401.0, HubSpot phase 8a)** — see §9's new bullet. The pre-ImpactIQ history import now brings in HubSpot meetings linked to a Deal, Company or Project, with the same exclusions, Relink, all-day cap and read-only screens as on Salesforce, and the nightly refresh keeps open historical Deals current. Shared table writes moved to `historical/store.ts`. The meeting search and association reads were checked live on test portal 247756533. Tests: `hubspot/historical.test.ts` (10).
- **HubSpot MCP tools (v1.402.0, HubSpot phase 8b)** — see §9's new bullet. The MCP CRM tools run on whichever CRM the install uses: `crm.search_opportunities`, `crm.search_accounts`, `crm.get_record`, with `salesforce.search_opportunities` kept as an alias. The alias's results gain a `crm` field, `sf_not_connected` became `crm_not_connected`, and `crm_provider_mismatch` is gone since it now runs on HubSpot too; `docs/mcp.md` says so for anyone with an existing agent setup. Tests: `crm/mcpTools.test.ts` (8), which also caught `crm.get_record` opening a CRM session before checking the id (fixed).
- **CRM name follows the Integrations choice (v1.403.0)** — see §9's "CRM name in every string" and §15. The owner asked
  that every "Salesforce"/"SF" in the app follow Admin → Integrations → CRM so a future CRM adapts with no string edits.
  205 strings across all 7 locales now use `{{crm}}`/`{{crmShort}}`, 66 `_hubspot` variants that only swapped the name
  were removed, SF Field Mappings is renamed CRM Field Mappings, and the suggested-meeting match chips (untranslated
  until now, with "Refresh from Salesforce" and Opportunity/Account labels) are translated and read Deal/Company on
  HubSpot. Also fixed: `leader.plan_vs_actual.hint` was a truncated translation in 6 locales and pointed at a page name
  that no longer exists. First of four CRM-generic PRs (next: Field Mappings CRM toggle, Activity Types extras, Team/User
  Management + Sales Team Alignment + Historical Import).
- **CRM Field Mappings: Salesforce / HubSpot toggle (v1.404.0)** — see §9's "CRM Field Mappings toggle". The owner chose
  option B: one page renamed CRM Field Mappings with a toggle defaulting to the active CRM, so mappings for the other CRM
  can be prepared before switching. Validate & dry run follows the toggle. Second of four CRM-generic PRs.
- **Activity Types extras follow the CRM (v1.405.0)** — see §9's "Activity Types extras follow the CRM". The owner: "make the
  Salesforce Extras generic to CRM... do not lose any functionality for Salesforce." The Opp field kind now works on
  HubSpot Deal properties (read, and edit when set to read & write), each extra shows only on its own CRM, and the admin
  editor says which CRM an extra belongs to. Salesforce extras are unchanged. Also closes a gap where the per-type extras
  routes didn't check the type's team. Third of four CRM-generic PRs.
- **Team Management, User Management, Sales Team Alignment and Historical Import follow the CRM (v1.406.0)** — see §9's
  "Team Management, User Management and the CRM user link follow the CRM". The owner: "In team Management we can map the people
  and departments... Need to do the same in the User Management user linkage to the SF user." On HubSpot the people
  pickers list HubSpot owners, departments are HubSpot teams, a manual owner link in User Management overrides the email
  match everywhere, and the remaining wording on these pages follows the CRM. Sales Team Alignment already followed the
  CRM (v1.400.0). Last of four CRM-generic PRs.
- **Any CRM selectable on Admin → Integrations → CRM (v1.407.0)** — see §9's "Choosing the CRM + the lock". The owner:
  "It should still allow you to switch to a CRM provided no matter the config but notify you that it is not configured."
  Choosing HubSpot without a saved connection used to be refused (409 `errors.hubspot.not_configured`) while Salesforce
  wasn't checked at all; now neither is, and the card warns instead. The Salesforce card also used to vanish whenever
  Salesforce wasn't the CRM (so None showed only HubSpot); both cards now always show, each with a note when it isn't the
  chosen CRM. Removed `admin.integrations.hubspot.not_active_crm`.
- **My Connections and the Account roll-up help follow the CRM (v1.408.0)** — the owner: My Settings → My Connections still
  showed a Salesforce card on HubSpot. HubSpot has no per-user sign-in, so on HubSpot the card (`HubspotMeCard` in
  `Settings.tsx`) shows the HubSpot owner the user is matched to (manual link, else email) and the portal, with an amber
  note when no active owner matches; with no CRM only Outlook shows. The sidebar's CRM status reads "HubSpot Connected" /
  "HubSpot: not matched" from the same data (`hooks/useCrmMe.ts`, one fetch per page load). New `GET /api/crm/me` (`routes/crm.ts`, any
  signed-in user; HubSpot: `{configured, portalName, owner}`, other CRMs: just `{provider}`), tested in
  `routes/crm.me.routes.test.ts`. The owner also asked whether the help popover next to the activity form's
  HubSpot Link (`SfRelationshipHelp.tsx`) needed updating: on HubSpot it still described Salesforce fields
  (`Opportunity.AccountId`, `Opportunity.CampaignId`, `Lead.ConvertedAccountId`). The 9 `sf_relationship.*` keys gain
  `_hubspot` variants in all 7 locales, matching what the account drill actually does on HubSpot (`GET
  /api/activities/account-drill`): Deals roll up to their primary Company (the snapshot's `sf_account_id`), Leads to their
  primary Company via `sf_lead_account_link` (nightly), and Campaigns don't roll up (no Deal → Campaign link). The
  popover and SfSearch's Campaign/Lead hints pass `context: useCrmLabelContext()`.
- **CriteriaIQ projects matched by CRM id (v1.409.0)** — see §9's new bullet. The owner asked whether the CriteriaIQ field
  names should be read from its repo or discovered at first connection. CriteriaIQ had already shipped them
  (`crmOpportunityId`/`crmAccountId` plus `GET /api/projects` filters), so ImpactIQ codes against that API contract and
  checks each returned row, falling back to name matching on an older CriteriaIQ. Project suggestions now come by
  Opportunity/Deal id, with other projects on the Account/Company listed too. Tests: `criteriaiq/client.test.ts` (id
  compare, filter, name fallback, old-version detection), `routes/criteriaiq.projects.routes.test.ts` (4), a Won w/o
  POC id case in `primaryProjects.test.ts`.
- **HubSpot meetings found and linked instead of logged twice (v1.410.0)** — see §9's "Meetings HubSpot already logged".
  The owner chose "find and link, plus admin switch" for reps whose calendars sync to HubSpot: write-back adopts the meeting
  HubSpot's calendar sync logged (same owner, start and end time), fills in only ImpactIQ's fields and never deletes it;
  CRM features gains **Create HubSpot meetings** (HubSpot only, default on) so an install can stop ImpactIQ creating
  meetings at all. New column `activities.crm_record_adopted` (migration 0158), named `crm_` ahead of the planned
  `sf_*` → `crm_*` rename. 12 new tests in `hubspot/writeback.test.ts`.
- **Activity CRM columns renamed sf_* → crm_* (v1.411.0)** — first of three rename PRs the owner picked ("Database + code, 3 PRs
  by area": activity columns, then the `sf_*` tables, then everything else; Salesforce-only names stay). The 35 CRM
  columns on `activities` (What/Who/Related links, Account, Opportunity and Evaluation snapshots, deleted flags, sync
  state) and `activity_sync_audit.sf_record_id` become `crm_*`, with their TypeScript keys (`sfWhatId` → `crmWhatId`).
  Migration 0159 renames each column only while the old name exists (idempotent); no data changes. The API JSON between
  client and server follows the new names, and MCP `activities.list` / `activities.get` output now reads `crm*`
  (`docs/mcp.md` says so). The enum types `sf_what_type` / `sf_sync_status` keep their names for PR 3.
- **CRM tables renamed sf_* → crm_* (v1.412.0)** — second of the three rename PRs. Migration 0160 renames the 16 tables
  that hold data for either CRM (field mappings + junction, CRM users and alignments, Attach Rate coverage, the snapshot
  state and Lead → Account link, the seven historical import tables, Support Ticket attachments and activity type
  extras) with `ALTER TABLE ... RENAME TO`, each only while the old name exists and the new one doesn't; indexes, keys
  and foreign keys move with the table, their own names unchanged. The Drizzle exports follow (`sfUsers` → `crmUsers`).
  Kept: the Salesforce-only `sf_event_type_config` (HubSpot reads the type value from `team_activity_types`),
  `sf_user_names` and `sf_object_owner_cache`, and the audit action `sf_users.sync` so older audit rows still match
  the Audit Log filter. Columns inside the renamed tables and the enum types are left for PR 3.
- **Fresh-install migrations fixed, CI added, CLAUDE.md slimmed (v1.412.1)** — from an improvement review the owner asked for.
  (1) Reproduced on a real Postgres 16: drizzle's `migrate()` applies all pending migrations in one transaction, and
  migration 0006's `ALTER TYPE role ADD VALUE 'team_admin'` can't be used by later files before it commits (55P04), so
  every empty database failed, including the Setup wizard's own migrate step. Existing installs were unaffected because
  they migrated a few files at a time. New `src/server/db/migrator.ts` (`applyMigrations()`) applies each file in its own
  transaction under a session advisory lock and writes the same `drizzle.__drizzle_migrations` rows (drizzle's own
  `readMigrationFiles()` hash and journal `when`), so it is interchangeable with databases drizzle already migrated.
  Used by server boot, `POST /api/setup/migrate` and `npm run db:migrate` (now `src/server/db/migrate-cli.ts` instead of
  `drizzle-kit migrate`, which has the same single-transaction behavior). Verified: all 161 migrations plus the seed on an
  empty Postgres 16, and a second run is a no-op. (2) `.github/workflows/ci.yml`: server and client typecheck, i18n
  parity, `vitest run`, `npm audit --audit-level=high --omit=dev`, and a Postgres 16 service job that migrates an empty
  database twice and seeds it. (3) Removed the committed `vitest.config.js`/`.d.ts` build output (the v1.393.1 stale-build
  cause) and ignored it. (4) CLAUDE.md went from 496 KB to about 125 KB: the release history moved here verbatim, and the
  CRM provider/HubSpot/CriteriaIQ write-up, Salesforce detail and six feature write-ups moved to `docs/crm-providers.md`,
  `docs/salesforce-details.md` and `docs/features.md`, each replaced by a short summary; §18 gained a Known traps list.
- **CRM columns and enum types renamed sf_* → crm_* (v1.413.0)** — last of the three rename PRs (see CLAUDE.md §7's
  v1.413 note for the full list). Migration 0161 renames 47 columns on CRM-neutral tables and the four enum types
  (`ALTER TYPE ... RENAME TO`), each only while the old name exists; no data changes. Salesforce-only tables keep their
  `sf_*` columns, and stored values keep their old text (enum value `sf_sync_failed`, historical `user_match_method =
  'sf_user_id'`, audit action `sf_users.sync`). The i18n interpolation variables `{{sfFieldApi}}`/`{{sfType}}` became
  `{{crmFieldApi}}`/`{{crmType}}` in all 7 locales to match the renamed params. Field Mappings and Activity Types export
  files keep importing through `renameLegacyKeys()`; tests in `src/shared/legacyKeys.test.ts` and
  `activityTypesTransfer.test.ts`.
- **Job locks, optional error tracking, container hygiene (v1.414.0)** — P1 items from the Oct 2026 improvement review.
  `scheduleJob()` now runs every tick (and Run Now) through `withJobLock()` (`services/jobs/jobLock.ts`):
  `pg_try_advisory_lock(727_445_302, hashtext(jobKey))` on a dedicated single-connection client (idle_timeout and
  max_lifetime off, since closing it would drop a held lock), so with two replicas only one runs a given job per tick and
  the other skips. An in-process set covers same-process overlap, because session locks are re-entrant. No database
  configured (setup mode, unit tests) runs the task as before; a failed lock query fails open. Run Now on a held job
  answers `alreadyRunning: true` and Scheduling shows an amber hourglass. Still single-instance: the in-memory rate
  limiter and pending backup uploads. Error tracking (`services/observability/errorTracking.ts`) is off unless
  `SENTRY_DSN` is set, loads `@sentry/node` only then, turns off every SDK data collector except user-agent, and scrubs
  bodies, cookies, query strings and auth headers in `beforeSend`; it reports errors reaching Express, scheduler
  backstop throws and every `writeRun(..., 'error')` (message only, never `detail`). Dockerfile: `USER node` and a
  `HEALTHCHECK` on `/health` (which never touches the DB).
- **Core write-path tests, Azure-only sign-in fix, HubSpot smoke checklist (v1.415.0)** — P1 tests from the Oct 2026
  review: `routes/activities.write.test.ts` (create, the outlookEventId dedup including reactivating an archived row,
  PATCH ownership, the 90-day edit window, draft → submitted stamping `submittedAt` once and queueing one CRM sync,
  client retry), `routes/auth.login.test.ts` (same 401 for unknown email and wrong password, SSO-only accounts refused,
  no session cookie before MFA, enrollment, TOTP checked against an independent RFC 6238 copy, single-use backup codes,
  the depleted-codes 423) and `services/salesforce/writeback.flow.test.ts` (Event vs Task, update on re-sync, failure
  backoff and the retry cap, no connection, worker pick-up rule). Writing the login tests found that
  `users_auth_method_check` (migration 0012) never got `'azure'` when v1.323 added the Azure-only method, so saving a
  user as Azure-only failed in Postgres; migration 0162 recreates the constraint with all four values. Recorded the owner's
  decision that the HubSpot historical import stays meetings only (`docs/crm-providers.md`), and added
  `docs/hubspot-production-smoke.md` for the first production portal.
- **Split the largest files, pure moves (v1.416.0)** — P1 from the Oct 2026 review. `routes/admin.ts` keeps its gate,
  fiscal-year and maintenance-window routes and mounts 19 area routers from `routes/admin/` in the original order;
  `routes/dashboards.ts` keeps presets and mounts 10 from `routes/dashboards/` (shared helpers in `shared.ts`);
  `routes/auth.ts` keeps password, MFA and sessions and mounts `routes/auth/` (OIDC helpers in `oidc.ts`, plus profile,
  okta, azure, salesforce, microsoft, apiKeys); `ActivityForm.tsx` moves five self-contained components into sibling
  files. Every move was checked by comparing line multisets (only `export` keywords and file-header comments differ),
  and the existing re-exports keep every import path outside these files working.
- **Team check on activity create (v1.417.0)** — `POST /api/activities` used to insert with whatever `teamId` the
  client sent (CSV import already checked). A new row now needs the team in `getAccessibleTeamIds()` (membership, or
  every active team for App Admins and can-see-all-teams users), else 403 `errors.forbidden`. The Outlook dedup path
  keeps the existing row's team and PATCH never changes `teamId`, so neither needs the check, and existing rows are
  untouched. The owner chose "count first": the count query for rows the rule would have refused is in the PR body.
- **Lazy-loaded changelog (v1.418.0)** — `nav.tsx`'s version popover now `import()`s `src/shared/changelog.ts` the
  first time it opens (one shared promise, reset on failure so the next open retries) instead of importing it
  statically, so the 250KB file is its own chunk rather than part of every page load. Shows a spinner while loading
  and a `changelog.load_failed` line on error. The server-side update checker reads the file from GitHub and is unchanged.
- **Phone layout for the weekly view (v1.419.0)** — Below 768px (`useIsMobile()`, a `matchMedia` hook) `AppNav` renders
  as a slide-in drawer over a dimmed backdrop, always expanded, closed by its X, the backdrop, Escape or any navigation;
  `PageHeader` gets a menu button (`md:hidden`) that opens it through `store/mobileNav.ts`, and hides the quarter pill,
  language picker and brand logo. Weekly View shows one pane at a time (List / Calendar toggle in the week bar; the
  calendar's collapse button returns to the list), with the week bar, day headers and calendar header wrapping. The
  calendar and the heatmap/charts under it moved into `calendarPanel` / `calendarExtras` constants used by both layouts.
  Every desktop class is restored at `md:`, so the desktop layout is unchanged (checked side by side at 1440px).
- **VectorIQ parity (v1.420.0)** — From the parity audit, as the owner chose. Visual changes:
  - **Sidebar:** links sit under Work / Insights / Learn / Admin headings, with a short rule in place of each heading
    when collapsed. The active row is a full highlight with a chevron when expanded and a round badge behind the icon
    when collapsed.
  - **Active links:** they match by prefix, so Guide stays highlighted on How to Use and Activities on `/activities`.
  - **Sidebar footer:** My Settings highlights when open, and Sign out turns red on hover. The user pill is an
    initials avatar with name and email; role, timezone and last login moved to its hover text.
  - **Page header:** a fixed 64px with the world-map watermark over the existing grid pattern, and a logo capped at
    140px.
  - **Admin nav:** normal-case category buttons, indented items, and the active item in the theme's primary color.
    The header shows "Admin › Category".
  - **Version popover:** shows 3 releases.
  - **Unchanged widths:** the sidebar stays `w-56` and the Admin column `w-60`, by the owner's call.

  New features:
  - **Global search:** Ctrl/Cmd+K over pages, Admin sections, help topics, and the caller's own activities through
    the new `GET /api/activities/search`. That route is owner-only, skips archived rows, takes LIKE wildcards
    literally, and returns at most 8 rows.
  - **Page help:** the ? opens How to Use ImpactIQ at the current page's section. The support mailbox moved to an
    envelope icon.
  - **404 page:** unknown paths render a not-found page.
  - **Admin URLs:** the open section is in the URL (`?section=`), and the category holding it opens automatically.
  - **Printing:** the chrome is hidden, scroll containers grow, and pages print in light mode.

  To support search, the sidebar's page list moved to `lib/appPages.ts`, the Admin section model to
  `lib/adminSections.ts`, and the manual's sections to `lib/howToUse.ts`.
- **Search follow-ups (v1.421.0)** — From the owner's report that "Eval" found nothing.
  - **Dashboards:** search lists dashboards by name, filtered like the Dashboard picker (the page's `dashboard` key, each
    dashboard's `dashboard.<tab>` key, and the Projects switch). The dashboard list moved to `lib/dashboardTabs.ts` so the
    picker and search share it. The open dashboard is now in the URL (`/dashboard?tab=<key>`), synced both ways.
  - **Guide:** search reads the active team's Guide cards (type name, Use This When, Usually Attach To, Examples,
    Subtypes) and the Distinctions text, and links to `/guide#guide-type-<id>` or `#guide-distinctions`. The Guide page
    scrolls to and outlines the target. Helpers live in `lib/activityTypeGuide.ts`.
  - **How to Use:** search matches each section's text, not just its title, and shows the matching words. A section
    about a page the user can't open (Activities, Dashboard, Scheduling, My Notes, Admin, Settings) is left out
    (`HOW_TO_USE_SECTION_PAGE_KEY`).
- **Security audit fixes, part 1 (v1.422.0)** — From the October 2026 security audit, in the order the owner approved.
  - **One team per request (H1):** `requestTeamId()` (`middleware/rbac.ts`) reads the team from params, body and
    query and answers 400 `errors.teams.conflicting_team_ids` when they disagree, so a role check can't pass on one
    team while the route reads another. GET and HEAD bodies are no longer parsed. `resolveTeamScope()` returns null
    for a team the caller can't see, which also closes `/stage-forecast-options` (L5).
  - **Activity reads (H2, H3, M2):** `services/activities/access.ts`'s `canViewActivity()` is the one rule: owner,
    App Admin, an admin/team_admin over the owner, or anyone who can see the team once the activity is submitted.
    Used by `GET /api/activities/:id`, the Salesforce and HubSpot ticket refresh and link-status routes, and notes
    (team note scopes and "all users" hide other people's drafts).
  - **Activity types (M1, L1):** a new or changed `activityTypeId` must belong to the activity's team (home team or
    `activity_type_teams`), else 400 `errors.activities.type_not_on_team`; `/sf-extras/:typeId`, `/by-sf` and
    `/eval-fields` check the caller's teams.
  - **Team routes (L2–L4):** every `/api/teams/:teamId/*` route 403s for a team the caller can't see, and subteam
    members only list a subteam of that team. Tests: `routes/accessScoping.routes.test.ts` (15).
- **Security audit fixes, part 2 (v1.423.0)** — H4 and M3 from the October 2026 audit.
  - **OAuth binding (H4):** `/auth/salesforce`, `/auth/salesforce-admin` and `/auth/microsoft` set an encrypted,
    HttpOnly, 10-minute binding cookie (`routes/auth/oauthBinding.ts`) holding a nonce, the user id and (Salesforce)
    the PKCE verifier. The signed state now carries the nonce instead of the verifier, so the verifier never appears in
    a URL. Each callback needs the state, the cookie (same nonce and user) and the live session (same user) to agree,
    else it redirects with `errors.oauth.session_mismatch`; the cookie is cleared either way. This stops a crafted
    callback link from attaching one person's Salesforce or mailbox tokens to another ImpactIQ account.
  - **Legacy sessions (M3):** `verifySession()` no longer accepts the pre-refactor HMAC cookie (`legacyVerify` and
    `upgradeLegacySession` are gone), so revocation, the idle timeout and sign-out-everywhere apply to every session.
  - Tests: `routes/auth/oauthBinding.routes.test.ts` (10).
- **Security audit fixes, part 3 (v1.424.0)** — M5 and M4 from the October 2026 audit.
  - **Trusted proxy hops (M5):** `trust proxy` was `true`, so any client could set `X-Forwarded-For` and pick the IP the
    per-IP limits (login, MFA, forgot password) keyed on. It is now a function reading `trustedProxyHops` from the Rate
    Limiting settings (0–3, default 0), applied without a restart; `TRUSTED_PROXY_HOPS` overrides it. The Rate Limiting
    card shows the forwarding header and resulting IP of the admin's own request, and warns when a header arrives while
    the setting is 0 (a proxy is probably in front and the setting needs raising).
  - **HubSpot access (M4):** HubSpot runs on one portal-wide key, so ImpactIQ is the gate. `hubspotProvider.connectForUser`
    returns no session for a user not matched to an active HubSpot owner (CRM search answers 403
    `errors.hubspot.no_owner_match_search`). A note push only targets the activity's own Deal and its Company (or its
    Company, for an Account-linked activity), else 400 `errors.notes.push_target_not_linked`. New setting Admin →
    Integrations → HubSpot → Who can edit Deals (`system_settings.hubspot_deal_edit_policy`,
    `services/hubspot/dealEditPolicy.ts`): `any_matched_user` (default, same as before) or `named_on_deal`, where the
    user must be named by owner id, email or name in one of up to 10 chosen Deal properties (dropdown labels compared
    too; fails closed with none chosen). Applies to the Assigned SE write and Deal field edits; the read routes report
    `canWrite`/`canEdit` so the form shows the field read-only. Project writes keep the matched-owner rule. Audited as
    `integration.hubspot.deal_edit_policy`.
  - Tests: `trustedProxyHops.test.ts` (5), `dealEditPolicy.test.ts` (6), `hubspotAccess.routes.test.ts` (4).
- **Security audit fixes, part 4 (v1.425.0)** — L6 to L9 from the October 2026 audit.
  - **CriteriaIQ link (L6):** `PUT`/`DELETE /api/criteriaiq/evaluation-link` change an install-wide link, so they now
    need an App Admin, the caller's own activity on that Evaluation (`crm_related_id`), or a leader/admin role on a team
    with one; else 403 `errors.criteriaiq.link_not_allowed`. Reading stays open.
  - **Preview snapshot (L7):** `readSnapshot()` (`services/salesforce/preview.ts`) takes the viewer and only reads the
    viewer's own activities or submitted ones on teams from `getAccessibleTeamIds()`. Both preview routes
    (`/api/salesforce/preview`, `/api/crm/preview`) pass it.
  - **Disable a user (L8):** `users.disabled_at` / `disabled_by` (migration 0163). App Admin only:
    `POST /api/admin/users/:userId/disable` revokes every session and API key in one transaction
    (`services/auth/userStatus.ts`); `/enable` restores sign-in only. Not for yourself or the default admin. `requireAuth`,
    `verifyApiKey()` (REST and MCP), password login, both MFA steps, change-password and the Okta/Azure callbacks refuse
    a disabled account (`errors.auth.account_disabled`). API keys also get 428 while `must_change_password` is set.
    User Management shows a Disabled badge and a disable/re-enable button. Audited `user.disable` (destructive) /
    `user.enable`.
  - **Setup token (L9):** in setup mode every `/api/setup` route except `GET /status` needs `X-Setup-Token`, a random
    token printed to the server log at startup (or `SETUP_TOKEN`, 16+ characters). The wizard asks for it first (step 0)
    and keeps it in memory only.
  - Tests: `userDisable.routes.test.ts` (3), `setupToken.routes.test.ts` (3), `recordScoping.routes.test.ts` (2).
- **Header dropdowns cut off (v1.425.1)** — From the owner's report that the language and Notifications menus opened behind
  the page. v1.420.0 gave the top bar `overflow-hidden` with its fixed 64px height, which clipped every dropdown that
  hangs below it. The bar now uses `overflow-x-clip`, which still stops a crowded phone header spilling sideways but
  lets menus extend down. The language menu also moved from `z-30` to `z-50`, matching the bell. Search (a portal
  modal), help (a link) and the sidebar version popover were not affected.
- **AI Assistant: Webhook provider (v1.426.0)** — phase 2 of the AI providers design. A new `webhook` kind
  (`src/shared/ai.ts`, family `webhook`, secret optional) sends each `runAi()` call as one signed JSON POST to an
  admin-chosen URL and reads `{ text | json, usage?, refused? }` back (`callWebhook()` in `services/ai/adapters.ts`).
  Contract and an n8n recipe: `docs/ai-webhook.md`.
  - **Signing:** `services/webhooks/signing.ts`: `Authorization: Bearer <secret>`, `X-ImpactIQ-Timestamp`,
    `X-ImpactIQ-Signature` = `sha256=` HMAC of `<timestamp>.<body>`. Outbound event webhooks will reuse it.
  - **Host checks:** `assertServiceUrl()` (the CriteriaIQ rule, generalized in `ssrfGuard.ts`) on save and on every
    call; `ai_providers.allow_private_network` (migration 0164) opts in to a private address. Redirects are not followed;
    answers over 1 MB are refused.
  - **Setup wizard:** no webhook (`AI_SETUP_PROVIDER_KINDS`), since setup routes answer before sign-in.
  - **Tests:** `webhook.test.ts` (10).
- **Notifications Clear all and grouping (v1.427.0)** — From the owner's request. The bell gets a Clear all button with an
  inline confirmation, backed by `POST /api/notifications/clear-all` (`clearNotificationsForUser()`), which deletes every
  row in the same team scope as the list and read-all. Today's nudges are muted until the next UTC midnight (the Mark
  read mute), never closed out forever like the row X, and announcements are dismissed as their own X does, so neither
  reappears on the next 60s poll. A By date / By category toggle (remembered in localStorage) groups the list by month
  or by category: Announcements, and nudges by their rule's name (`categoryName`, joined from `nudge_rules` in the GET).
  The group with the newest notification opens, the others collapse with an item count beside the name.
- **SSO sign-in errors shown (v1.427.1)** — Follow-up to the October 2026 audit. When the Okta or Azure callback refused a
  sign-in (disabled account, no ImpactIQ account, wrong sign-in method, missing or unverified email, IdP error), it
  redirected to `/?oktaConnect=error&reason=...` (or `ssoConnect`), but nothing read those params, so the user just landed
  back on the sign-in page with no explanation. The callbacks now send a reason key from `src/shared/ssoErrors.ts`
  (`errors.auth.sso_*` plus `account_disabled`) instead of English text, an IdP `error` maps to `sso_denied`
  (`access_denied`) or `sso_failed` and is logged server-side, and Login.tsx shows the message above the sign-in
  buttons, then removes the params from the address bar. The page only shows keys on that list, so a crafted link can't
  put its own text on the sign-in screen. A test checks every reason the callbacks use is on the list and translated.
- **Outbound event webhooks (v1.428.0)** — the owner asked for this alongside the AI Webhook provider. Admin → Integrations →
  Event Webhooks (App Admin only, `routes/admin/eventWebhooks.ts`) sends a signed JSON POST to an admin-chosen URL for
  five events (`src/shared/eventWebhooks.ts`): `activity.submitted`, `activity.crm_sync_failed`,
  `activity.outlook_deleted`, `nudge.sent`, `job.failed`. Contract and an n8n → Teams recipe: `docs/event-webhooks.md`.
  - **Tables** (migration 0165): `event_webhooks` (name, URL, encrypted `whsec_` secret shown once, events, optional
    team filter, private-network opt-in, active) and `event_webhook_deliveries` (one row per event per webhook, payload,
    status, attempts, next attempt, last answer).
  - **Queue, not inline:** `emitEvent()` (`services/webhooks/events.ts`) only inserts delivery rows and never throws;
    `event_webhook_worker` (`delivery.ts`, 30s, records a run only when it sent something) posts them with the AI
    webhook's signing (`signing.ts`) plus `X-ImpactIQ-Event` / `-Event-Id` / `-Delivery`. Retries after 1, 5, 15, 60
    minutes and 3, 6, 12 hours, then failed. Turning a webhook off drops its waiting deliveries; finished ones are culled
    after `EVENT_WEBHOOK_DELIVERIES_RETENTION_DAYS` (30).
  - **Emit points:** activity create/PATCH to submitted (`routes/activities.ts`), a final CRM write-back failure (SF and
    HubSpot `writeback.ts`), `flagDeletedOutlookActivities` (`outlook/sync.ts`), a newly inserted nudge notification
    (`routes/notifications.ts`) and `writeRun()` on error (not for the webhook worker itself). CSV import doesn't emit.
  - **Privacy:** a private meeting's title is sent as null; notes are never sent. `job.failed` has no team and ignores a
    webhook's team filter.
  - **Host checks:** `assertServiceUrl()` on save and before every send; no redirects; 15s timeout.
  - **Tests:** `eventWebhooks.test.ts` (14): subscription and retry rules, queueing, private title, signed delivery,
    retry then failed, redirects, address rules, turn-off and cull, App Admin gate, secret shown once, test send.
- **The CRM lock shows on the other CRM's connection card (v1.429.0)** — the owner asked whether the switch-over limit
  shows in the Admin console. The CRM card already disabled the other CRM's button (reason only in a hover tooltip)
  and the server refused the change, but the other CRM's connection card still offered a full setup form that could
  never be used. `CrmProviderCard` now shares the lock through a context (`useCrmLockedOut()`); while locked, the other
  CRM's card (Salesforce's `IntegrationCard` or `HubspotConnectionCard`) shows a Locked pill and `CrmLockedOutNote`
  instead of the Configure toggle, and the CRM card adds a visible line saying the other CRM can't be chosen or set
  up. None stays available in both directions. Nothing changes before the lock: a saved connection alone doesn't lock,
  only the first CRM-linked record does. Known limit and roadmap entry: `docs/crm.md` §3.5, CLAUDE.md §18.
- **Event Webhooks page 500 (v1.429.1)** — the owner reported Admin → Integrations → Event Webhooks showing HTTP 500 right
  after v1.428.0 shipped. `GET /api/admin/event-webhooks` passed a JS `Date` into a raw `sql` template (the 7-day
  delivered/failed counts); the production `postgres` driver can't bind a `Date` there, while the tests' pglite accepts
  it, so CI stayed green. Now an ISO string cast with `::timestamptz`. Every other Event Webhooks route and the delivery
  worker were run against a real Postgres 16 and worked. Added to CLAUDE.md §18 Known traps.
- **Demo Data is safe to run on a live install (v1.430.0)** — the owner asked whether Demo Data covers every feature; the
  review (Claude Doc "Demo Data coverage review") found four problems to fix before coverage work. (1) Generate now
  creates its own `[Demo] Sales Engineering` team (`DEMO_TEAM_SLUG`, `applyDefaultTeamConfig()`, generating admin
  joins as team admin) instead of writing into a team the admin picked, so demo users and activities never show in a
  real team's dashboards, compliance or nudges; one set at a time (`DemoDataExistsError` → 409
  `errors.demo_data.already_present`). Remove deletes the team through `deleteTeamCascade()`
  (`services/teams/deleteTeam.ts`, extracted from `DELETE /api/admin/teams/:teamId`), and still cleans pre-v1.430
  demo rows by their markers. (2) The demo Outlook flag now stores `userIds`; `isDemoCalendarUser()` serves the
  fixture calendar only to demo users and the generating admin, so every other account keeps its real Graph calendar.
  (3) Remove no longer deletes every `kind='nudge'` notification app-wide; demo rows go with the demo users and team.
  (4) The demo product catalog uses generic names (no vendor branding). Fixed seed replaces the team-id seed, since
  the team id is new each run. Test: `services/demo/generator.test.ts`.
- **Webhook person filter and four new events (v1.431.0)** — Event webhooks gain a person filter (`event_webhooks.user_ids`,
  migration 0166) beside the team filter; `emitEvent()` now takes an `EventScope` (`teamIds` null for teamless events,
  `userId` null for events not about one person). A person event matches the team filter on any team they're on. New
  events: `auth.suspicious_sign_in` (from `recordLoginEvent()`, same 90-day new-IP rule as the email), `user.disabled`
  (only on a real enabled → disabled change), `ai.budget_reached` (with the monthly App Admin email) and `anomaly.found`
  (new 6-hourly `anomaly_webhook_scan` job: runs `detectAnomalies()` per subscribed team for the last completed week,
  sends one event per team when there are findings, and records the (team, week) in `event_webhook_anomaly_scans` so
  it never repeats). The admin page gets a searchable people picker limited to the ticked teams.
- **Demo Data covers the dashboards (v1.432.0)** — The generator (`services/demo/generator.ts`) now seeds, inside the
  demo team: a `[Demo]` cost group ($95/h); Opportunity snapshot columns on linked activities (stage, forecast, amount,
  close date, won/lost, owner, Assigned SE) from 10 fixture Opportunities, two of them Closed Lost; three Projects
  (`Evaluations__c`) on Eval Work; two `[Demo]` subteams; Guide content and Subtypes via the new shared
  `seedGuideContent()` (`services/teams/seedGuideContent.ts`, also used by the Seed Default Content route) with the
  Subtype picker on; an Attach Rate field plus a coverage snapshot of 18 demo Opportunities; two years of
  `crm_historical_events`; and each demo user's fixture calendar stored in `outlook_events`, ~70% of it logged as
  activity (`outlook_event_id` set), with Meeting Load on. Hours are weighted by type at ~24–33 h/week per person, never
  in the future, and the last completed week plants an over-capacity person, a stopped logger, an RFx Work surge and an
  Opportunity burn spike so What changed fires. The fixture calendar is now seeded per (user, day), so any window
  returns the same event ids. Safety: `services/demo/ids.ts` — Salesforce snapshot / disconnected-link jobs skip
  `demo-` ids (one malformed id fails a whole `Id IN (...)` batch; HubSpot jobs already skip non-numeric ids), and
  `demoCoverageCond()` keeps demo coverage rows out of every real team's Attach Rate and attach-rate history.
  `deleteTeamCascade()` also clears `attach_rate_fields`, `attach_rate_history`, `opp_review_dismissals` and
  `subteam_users`, whose FKs don't cascade (a team with Attach Rate fields could not be deleted before).
- **Slack DMs for nudges and announcements (v1.433.0)** — the owner asked how to send alerts to Slack for a specific user or
  team. Before this, Slack only posted nudges to the team's Incoming Webhook channel; the bot token and
  `users.slack_user_id` (Integrations → Slack → Sync users) existed, but `sendSlackDm()` had no caller.
  - **Nudge DMs:** `nudge_rules.send_slack_dm` (Nudge Rules → "Also send as a Slack DM", default off) DMs the person
    through `deliverSlackDmToUser()` (`services/slack/dm.ts`), which skips (never errors) when Slack isn't connected, the
    user isn't linked, has `user_notification_prefs.slack_dm_enabled` off (My Settings), or is disabled. A sent DM writes
    a `nudge_events` row with channel `slack_dm`.
  - **Announcements:** `announcements.send_slack` sends once when the announcement first becomes active (UTC date),
    claimed through `slack_sent_at` (`services/slack/announcements.ts`). Team-wide goes to the team channel when one is
    set, else DMs every member; subteam and person targets get DMs. Left unclaimed while nothing could deliver it.
  - **`notification_sweep` job** (`services/nudge/sweep.ts`, 30 min, Admin → Scheduling): `syncNudgeNotifications()`
    moved to `services/nudge/sync.ts` and now also runs for every active, non-demo user during their working hours
    (Mon–Fri 08:00–18:00 in `users.timezone`). Nudges used to be evaluated only by the bell's poll, so Slack, email and
    `nudge.sent` only fired for someone with the app open. The per-day dedupe keeps poll and sweep from sending twice.
    Behavior change: nudge emails (rules with "Also send by email") now arrive without a login too.
  - Migration 0167. Test: `services/slack/slackRouting.test.ts`.
- **Demo Data fills the exception queues (v1.434.0)** — `applyExceptionStates()` (`services/demo/exceptionStates.ts`) puts a
  few demo rows in each state a queue looks for: drafts this week, three failed syncs parked at the retry cap, synced rows
  with `demo-rec-*` ids, disconnected What/Related links, approved meetings deleted from Outlook (one in the admin's own
  Keep / Delete queue, picked with no CRM record), triaged Why Meeting? reasons, Marketing event names, notes, travel costs,
  `demo-ticket-*` support tickets and Non-Activity marks. The fixture calendar adds private, cancelled, tentative, free and
  all-day events, and only loggable ones are logged. Eval Work and Support get Project and Ticket picker extras. An
  optional demo Team Leader (`leader.demo@demo.impactiq.local`, password sign-in, must change at first sign-in) leads the
  demo team only; the password is returned once and never logged. `parkDemoActivitySync()` stops both write-back workers
  from sending a demo-team or `demo-` id activity to a CRM. `demo_data.generate` / `demo_data.remove` are audited.
- **Demo Data covers Leads, Campaigns, nudges and announcements (v1.435.0)** — Fixtures in `services/demo/crmFixtures.ts`:
  six `demo-lead-*` Leads (two converted, with `crm_lead_account_link` rows to demo Accounts) on some Discovery/Demo
  work, and four `demo-camp-*` Campaigns on Marketing work (its Event Name is the Campaign name), each only when that CRM
  feature is on (`getEffectiveCrmFeatures()`). `services/demo/engagement.ts` adds `nudge_events` from the demo team's own
  rules over the window (worded from each rule's template; the planted stopped logger gets No Activity Days), two snoozes,
  and four announcements (a running one for a demo subteam, one for the demo leader, one scheduled and one ended; nothing
  running targets the whole team, so the generating admin gets no banner). On HubSpot (`crm_provider = hubspot`) stages,
  forecast names and coverage use HubSpot's default pipeline vocabulary, and the Eval Work picker and Project links use
  HubSpot Projects (`0-970`). CriteriaIQ is not faked: its Project cards read the live CriteriaIQ API. Remove also clears
  demo Lead links and any activity with a `demo-` What or Who id.
- **Slack DMs from Communications rules (v1.436.0)** — the owner asked whether Admin → Communications could send to Slack,
  with admin alerts going to admins only. `email_rules.send_slack` (migration 0168) adds an "Also send as Slack DM"
  switch, shown for the rules in `SLACK_DM_EMAIL_RULES` (`src/shared/emailRuleSlack.ts`): `daily_digest`,
  `weekly_recap`, `login_new_location` (to the user) and `job_failure_alert`, `ai_budget_reached` (to App Admins, the
  same people the email already goes to). Left out: `nudge_email` (nudge rules have their own DM switch), welcome,
  invitation, password reset and the test emails. `sendByRule()` takes the recipient's `userId` and sends the DM
  through `deliverSlackDmToUser()` before the email, so an SMTP error can't swallow it; with no email integration, a
  delivered DM counts as sent. The job failure and AI budget loops now keep going past one admin's failed send, and
  the job failure alert stamps `last_error_email_at` only when something went out. Test:
  `services/email/ruleSenderSlack.test.ts`.
- **v1.437.0** — Scheduling follows the CRM choice. `services/jobs/jobCrm.ts` maps every CRM job to `salesforce`,
  `hubspot` or `any` (shared historical jobs); `scheduleJob()` skips a job on any other CRM and Run Now answers 409
  `errors.scheduling.job_inactive_crm`, so the gate no longer depends on each task remembering its own check
  (`hubspot_owner_sync` didn't: it ran on Salesforce installs whenever a HubSpot key was saved). Admin → Scheduling lists
  only the jobs that apply, and recent runs / Failed Runs (7d) follow the same list. Parity audit: Salesforce had no
  scheduled user sync (crm_users refreshed only from the Sales Team Alignment button), so `salesforce_user_sync`
  (`services/salesforce/users.ts`) now runs nightly like `hubspot_owner_sync`, and the manual button records its run the
  same way. `detect_disconnected_links` was running but missing from the Scheduling list. Job keys are unchanged
  (job_config / job_runs rows are keyed by them). Test: `services/jobs/jobCrm.test.ts`.
- **v1.437.1** — `runHubspotOwnerSync()` returns early unless HubSpot is the active CRM, so every caller follows the
  rule, not just the scheduler. v1.437.0 stopped the nightly `hubspot_owner_sync` on other CRMs, but the HubSpot card's
  Sync owners button (`POST /api/admin/integrations/hubspot/sync-owners`) still called it directly, so a saved key on a
  Salesforce or None install could pull HubSpot owners into `hubspot_owners` / `crm_users`. The route now answers 409
  `errors.hubspot.owner_sync_inactive_crm` and the button is disabled with that text as its tooltip. Test:
  `services/hubspot/owners.test.ts`.
- **v1.438.0** — Jobs wait for their integration. `services/jobs/jobReadiness.ts` (`JOB_NEEDS`) names what each job
  needs: the Salesforce connected app (write-back, notes), the admin Salesforce connection (snapshots, coverage, link
  health, user sync), the HubSpot key (every HubSpot job), the active CRM's org-wide connection (historical refresh /
  backfill), Microsoft Graph (Outlook write-back), CriteriaIQ, the App Updates GitHub token, email or Slack (digest,
  weekly recap) and an active event webhook (webhook worker, anomaly scan). `scheduleJob()` skips the tick and Run Now
  answers 409 `errors.scheduling.job_not_set_up` until it's connected; Admin → Scheduling shows Not set up with the
  reason in place of Active / status / message, and leaves such jobs out of Jobs in Error and Never Run. A check that
  throws counts as set up, so a settings read failure never parks a job. `refreshHistoricalOpps()` checks for open
  historical Opportunities before the admin connection and writes no run row when there are none (matching the HubSpot
  side), so an install that never ran the import stops logging a nightly `no_admin_sf_connection` error.
- **v1.439.0** — Admin → Scheduling groups jobs into collapsible categories (`src/shared/jobCategories.ts`: CRM
  write-back, CRM and Project data refresh, historical import, Outlook calendar, notifications and email, event
  webhooks, accounts and security, housekeeping and app updates; a job missing from `JOB_CATEGORY` lands in Other, and
  a test fails if a listed job isn't filed). All groups start collapsed, each header shows its job count, and an
  expand/collapse all button sits under the KPI cards. A category name is red when any of its jobs' latest run is an
  error, the same rule as the Jobs in Error card (waiting-for-setup jobs and older failed runs don't count). Recent runs
  takes `?recent=20|50|100` (anything else is 20) and shows a Category column. Also fixes an intermittent Demo Data test failure: this week's draft
  Marketing activities never got an event name, so a Campaign-linked draft broke the "event name matches the Campaign"
  check whenever the random draft pick landed on one (`services/demo/exceptionStates.ts` now names every Marketing row).
- **v1.440.0** — System Health Overview on App Health (`services/health/overview.ts`, `GET /api/admin/health-overview`,
  `components/admin/HealthOverview.tsx`). Tiles: Database (connections, pending migrations, queries running 5+ min,
  sessions idle in a transaction), Background Jobs (latest run failed; overdue from the new scheduler heartbeat,
  `getJobHeartbeats()`: armed tick late by more than max(2 min, interval), or one tick running longer than max(1h,
  2× interval)), Queues (CRM write-back, notes push, Outlook write-back, event webhooks: pending count and oldest
  age, amber at 15 min, red at 1h, plus unresolved failures counted like CRM Sync → Issues), Integrations (configured
  or not, plus a job using it that failed in the last 48h), Email (new `email_deliveries` log, migration 0169,
  `EMAIL_DELIVERIES_RETENTION_DAYS` default 30; failures with no successes in 24h is red), AI Assistant (no default
  provider, budget at 80% / 100%, error share of 24h calls) and App Server (uptime, memory, error tracking). No live
  external calls; each tile fails on its own. `/ready` readiness endpoint (503 until `SELECT 1` answers within 3s);
  Docker's HEALTHCHECK stays on `/health`. `getMigrationStatus()` moved to `services/health/migrations.ts`. Test:
  `services/health/overview.test.ts`.
- **v1.441.0** — Admin → Scheduling follow-ups. Each category header shows a green "N active" / red "N inactive" pill
  before the job count (active = turned on and set up; inactive = turned off or Not set up; a zero side is gray).
  Recent runs is paged (`?recentPage=`, page size still 20/50/100, default 20) with a total, and a Clear icon button
  (`POST /api/admin/scheduling/recent-runs/clear`, audited `job_runs.clear`) stores the time in `system_settings`
  (`scheduling_recent_runs_cleared_at`) so the list shows only later runs. Clear deletes nothing: the KPI cards, each
  job's last run and the 7-day failure count still read every run, and rows age out with `JOB_RUNS_RETENTION_DAYS`.
- **v1.442.0** — App Health's System Health Overview tiles and database stat cards use solid (opaque) status backgrounds; the
  semi-transparent tints let the page's world-map watermark show through.
- **v1.443.0** — Admin → Scheduling's Clear deletes every `job_runs` row (v1.441.0 only hid them behind a stored
  timestamp, now dropped), audited `job_runs.clear` as destructive; the KPI cards, Last run and Failed Runs (7d) start
  over. Fixed a startup race: every job was scheduled before `start()` applied migrations, and `sync_audit_cull` fires
  at boot, so on the first boot after v1.440.0 it queried `email_deliveries` before migration 0169 created it. Jobs now
  wait on `holdJobsUntil()` (`services/jobs/scheduler.ts`), released once migrations settle (failed included). The cull
  also runs each table as its own step, so one failure doesn't skip the rest, and reports the database's own error.
- **v1.444.0** — App Health, remaining gaps. Each integration client (Salesforce, HubSpot, Microsoft, Slack, CriteriaIQ)
  reports its own call outcome to `integration_status` (`services/health/integrationStatus.ts`, migration 0170;
  fire-and-forget, throttled to one success write a minute and one failure write every 10s), so the Integrations tile
  shows the last OK / failed call without App Health probing anything. A failed per-user token refresh sets
  `user_integrations.last_error/last_error_at` (cleared on refresh or reconnect), counted as "need to reconnect" for
  active users; stale calendars are Microsoft-connected users who signed in within 3 days but whose calendar hasn't
  synced in 3. Database tile adds cache hit ratio, dead rows and last vacuum. New Data & Backups tile: retention check
  against `RETENTION_POLICIES` (`services/health/retention.ts`, now also the source of the cull's periods, 2-day grace)
  and a backup reminder (`backup_last_export` / `backup_reminder_days` in `system_settings`, set on Backup & Restore,
  0 = off). A Readiness check panel under the tiles lists what to point at `/ready` and what stays on `/health`, and
  shows the last caller (in memory, per server).
- **v1.445.0** — What's new is categorized. Each `CHANGELOG` bullet is now `{ category, text }` with CriteriaIQ's four
  categories (`security`, `feature`, `improvement`, `fix`; `src/shared/changelogCategories.ts`), and the version chip
  popover and App Updates panel render them as colored sections (`components/ui/changelog-highlights.tsx`). All 1,288
  existing bullets were categorized after the fact: a keyword pass, then a read-through of every bullet. The App Updates
  parser still accepts plain-string bullets (as Improvements), and now decodes `\uXXXX` escapes, which it used to show
  as a literal `uXXXX`. An install older than v1.445.0 that checks for updates will see the new version but no bullet
  text until it updates, since its parser only keeps string bullets.
- **v1.446.0** — Admin → Workplace → Terminology (App Admin, `system_settings.terminology`, `src/shared/terminology.ts`,
  `services/config/terminology.ts`): Eval / POC / POV / POx / Project / Custom, default POx. It names the evaluation
  Activity Type ("{term} Work") in `applyDefaultTeamConfig()`, `drizzle/seed.ts`, Seed Default Content and the demo
  data, the default Guide Distinctions (`defaultGuideDistinctions()`) and `stage_no_type` nudge rule, and the client's
  `{{evalTerm}}` / `{{evalWork}}` i18n variables (`store/terminology.ts`, loaded in `PageShell`). Existing installs:
  migration 0171 pins any install that already has an "Eval Work" type to Eval, so upgrading renames nothing. A later
  change previews and (opt-out checkbox) renames exact-name matches in one transaction: an empty CRM picklist override
  becomes the old name so write-back sends the same Type value, nudge rule configs/conditions/messages and Guide
  Distinctions on those teams follow, and a team that already has a type with the new name is skipped. Audited
  `terminology.update`. New-team defaults copy that override, and their `stage_no_type`/`type_no_followup` messages now
  use `{days_overdue}` like seed.ts.
- **v1.446.1** — Collapsed sidebar kept a hover background on previously clicked nav icons. The links set
  `backgroundColor` by hand in `onMouseEnter`/`onMouseLeave` and skipped the reset once the link was active; expanded,
  the active style's own background overwrote it and was removed on navigating away, but collapsed the active style has
  no background (the badge carries it), so React never touched the hand-set value. Nav links and the My Settings button
  now hover through a `hover:bg-[var(--nav-hover-bg)]` class (`nav.tsx`), no DOM writes.
- **v1.447.0** — CriteriaIQ summary API. `services/criteriaiq/client.ts` probes CriteriaIQ's versioned
  `/api/v1/projects` contract once per URL and key and reads single projects, Opportunity/Account lookups and Evaluation
  links through it (`fromCriteriaIqSummary()`), keeping `GET /api/projects` for search, the nightly refresh and older
  CriteriaIQ installs. Criteria counts come from CriteriaIQ itself (met = `complete`); the old path counted only
  pass/passed/met, which CriteriaIQ never uses, so every project showed 0 met. The drawer's CriteriaIQ panel shows MAP
  task progress (`activity.criteriaiq.map_progress`).
- **v1.448.0** — Effort API for CriteriaIQ (Phase 3 of the CriteriaIQ parity work). A new `effort:read` API key scope
  (Leader/admin to mint, like `mcp:read`) reaches only `GET /api/v1/effort?crmOpportunityId=`, which returns hour
  totals for one Opportunity by person and activity type, from submitted activities on the key owner's teams. Chosen
  over storing a `rest:full` key in CriteriaIQ, which would let a leak there read and change anything its owner can
  here. No titles, notes or meeting details leave; the owner's leader role is re-checked on every call. Contract in
  `docs/effort-api.md`.
- **v1.449.0** — Effort API cost and a deep link for CriteriaIQ (F-6 of the CriteriaIQ parity work). `GET /api/v1/effort`
  adds `cost` (`totalCost`, `laborCost`, `directCost`, USD, plus `activitiesWithoutRate`), computed like the cost
  dashboards (`resolveCostBatch()` rate for that person, team and day × hours, plus direct costs, FX to USD). Only one
  total: a per-person or per-type figure divided by its hours would give a person's rate. `?openOpportunity=<id>&name=`
  on any page opens `SfActivitiesModal` for that Opportunity on the active team (`OpportunityDeepLink.tsx`); an 18-char
  Salesforce id also matches its 15-char form.
- **v1.450.0** — CriteriaIQ live refresh (P3-2 of the CriteriaIQ parity work). CriteriaIQ posts a signed webhook to
  `POST /api/webhooks/criteriaiq` when a project changes; ImpactIQ drops its cached CriteriaIQ reads on every replica
  (a `cacheEpoch` in `criteriaiq_config` that every cache key carries) and re-reads that project's snapshot when
  CriteriaIQ is primary. Chosen over a shorter cache (still minutes stale, more load) and over polling. Only the
  timestamp-bound `X-CriteriaIQ-Signature-V2` header is accepted, because CriteriaIQ's original signature didn't cover
  the time and could be replayed; replays inside the 5-minute window are refused through `criteriaiq_webhook_receipts`,
  a table rather than memory so it holds across replicas. Needs CriteriaIQ v0.11+ (its PR #386).
- **v1.451.0** — Demo Data round 2. Settings (timezone, approved / declined / out-of-office shares, PTO days per person,
  plus the existing counts and leader option) are stored in the `demo_outlook_enabled` flag, so Reseed
  (`POST /api/admin/demo-data/reseed`, audited `demo_data.reseed`) removes and regenerates from them and the form starts
  from them; Remove keeps the settings. With a timezone the generator lays out local days (`services/demo/timezone.ts`,
  DST-aware) and sets the demo people's `users.timezone`; with none it is the old UTC layout byte for byte. Declines and
  OOO days come from a second seeded stream so the rest of a day's calendar doesn't move. PTO is real `user_pto_days`
  rows, an all-day PTO event and no logging that day. Every live fixture read goes through `demoCalendarFor()` (weekly
  view, calendar panel, Scheduling) so it matches what was stored; Scheduling fills in the admin's unstored calendar and
  demo people's days after Generate, and the admin joins `[Demo] East`. About a quarter of demo people's linked
  activities and most of the admin's get `activity_notes`. The demo leader's password is kept encrypted with
  `TOKEN_ENCRYPTION_KEY` and shown on Current state (App Admin only, with a check that it still signs in), so it is no
  longer forced to change at first sign-in. Generate, Reseed and Remove reload the app into the demo team.
  About 90% of demo activities carry a Subtype (was 70%), and active types the default content leaves without Subtypes
  (Meeting) get demo ones (`seedMissingDemoSubtypes()`, demo team only). An **Activity names** list (one per line, up
  to 50, cleaned by `cleanDemoActivityNames()`, stored with the settings) names about half of customer meetings
  (`<name> — <customer>`, so the subject still maps to its type and record) and of activities logged without a meeting;
  both draw from their own seeded streams, so an empty list leaves the data unchanged.
- **v1.452.0 — Gong connection (Gong plan, phase 1).** Admin → Integrations → Gong (App Admin): access key + secret
  (default, HTTP Basic, tried against `/v2/users` before it is saved) or a Gong OAuth app (`/auth/gong` →
  `/auth/gong/callback`, the same signed state and encrypted binding cookie as the Salesforce/Microsoft connects; Gong has
  no per-user OAuth, so a Gong tech admin authorizes once). Settings in `system_settings.gong_config`, every secret
  encrypted with `encryptToken`; the API host must be `api.gong.io` or `*.api.gong.io` (`normalizeGongApiBaseUrl()`), and
  OAuth adopts the tenant host Gong returns. All calls go through `services/gong/client.ts` (3 req/s limiter, Retry-After,
  OAuth refresh, `recordIntegrationCall('gong')`). Check access probes the users / workspaces / calls / transcripts scopes;
  the daily `gong_user_sync` job (new Transcripts category, waits for Gong in `JOB_NEEDS`) fills `gong_users` (migration
  0173) and the card lists ImpactIQ people with no Gong user of the same email. Transcript cache period stored now (30
  days default, 1–365), used by phase 2. Built from Gong's docs: there is no Gong test tenant yet, so the scope names
  and response shapes still need a live check.
- **v1.453.0** — Connecting CriteriaIQ, documented in the app. How to Use ImpactIQ gains a `criteriaiq` section
  (searchable, admin-only in search like the Admin section) with the full setup in both apps: a Read only CriteriaIQ API
  key, the connection on Projects (POC|POV), primary vs. secondary source, live refresh (endpoint, secret, the CriteriaIQ
  webhook and its events, the wizard's test as the check), the `effort:read` key for CriteriaIQ's SE Effort card, and
  troubleshooting (401 = secret mismatch, 404 = live refresh off, clock skew). The CriteriaIQ connection card links to
  it, and its key and webhook hints now name CriteriaIQ's real menus (Admin › Integrations › n8n › API Keys; Admin ›
  Integrations › Webhooks, secret under Advanced Settings) instead of paths that don't exist there.
- **v1.454.0 — Project activity counts for CriteriaIQ.** `GET /api/v1/effort/activity-types` (active type names on
  the key owner's teams, merged by name, with `hasProjectPicker` = a `related_object_picker` extra on any of them) and
  `POST /api/v1/effort/project-counts` (`services/activities/projectActivityCounts.ts`), both behind the existing
  `effort:read` key. A project's count = submitted, unarchived activities of the chosen type names linked to its record
  (`crm_related_type` `CriteriaIQ` + project id, or `crm_related_id` = the CRM Evaluation / HubSpot project, Salesforce
  ids on their 15-char form). Optional `opportunityFallback` adds unlinked activities on the project's Opportunity
  dated inside its start/end dates; it can count one activity on two projects, so CriteriaIQ warns before it is
  turned on. One indexed query fetches candidate rows and the per-project split is done in memory. POST because 200
  projects don't fit in a URL; CSRF skips that one path since it accepts only Bearer keys. `mcpRateCheck()` takes a
  weight (one call per 50 projects). Migration 0174 adds `left(crm_related_id, 15)` and `left(crm_what_id, 15)`
  indexes, which the existing effort API's Opportunity match also uses.
- **v1.455.0 — Gong Transcripts tab (Gong plan, phase 2).** The `gong_call_index` job (every 15 min, Transcripts
  category, waits for Gong) reads call metadata from `POST /v2/calls/extensive` into `gong_calls` (parties, CRM context,
  calendar event id; never transcript text), re-reading the last day each pass and backfilling one 30-day slice per tick
  back to 365 days. Activity links live in `activity_gong_calls` (snapshot of title/url/start, link method, score);
  transcripts are fetched on first open into `gong_transcript_cache` and culled by the housekeeping sweep after the
  card's cache period (App Health retention reads the same setting). Migration 0175 also adds
  `teams.transcripts_leader_access`, `users.gong_user_id` and seeds the `activities.transcripts` Role Management key for
  contributor / leader / team_admin. `/api/gong/*` (`routes/gong.ts`): suggestions (`scoreGongCall()`: same calendar
  meeting = 100, else start within 15 min +40, owner on call +25, attendees +5 each up to 3, same CRM id +20, title up
  to +10; shown at 40+, top 5) and search only list calls the owner or the caller was on; linking is owner or App Admin;
  a transcript is served only past `canReadTranscript()` (owner, on the call, App Admin, or the team's leader switch).
  Gong card gains Index calls now, the per-team switch and manual Gong user links (placed on the Gong card rather than
  Team / User Management to keep Gong settings in one place). lucide-react upgraded 1.47 → 1.66 (approved by the owner) for the tab's
  `MessageCircleText` icon. Still unverified without a Gong tenant: response shapes, the calendar event id format and the
  `t=` seconds parameter on call URLs.
- **v1.455.1 — glob and minimatch advisories.** Dependabot #43 (glob AbortSignal cancellation bypass, GHSA-3g3m-2fjr-6pw4)
  and #44 (minimatch globparts DoS, GHSA-g3hv-75wg-m249). Both came in only through `@sentry/node` →
  `@sentry/bundler-plugins` → `glob@13`, and the latest Sentry still asks for `glob@^13`, so root `overrides` pin
  `glob@^14.0.3` and `minimatch@^11.0.3`. Sentry only calls `glob(patterns, { absolute, nodir })`, which glob 14 keeps.
  Drop the overrides once Sentry moves to glob 14.
- **v1.456.0 — Gong auto-link and webhook (Gong plan, phase 3).** `gong_auto_link` (every 15 min, Transcripts category,
  waits for Gong, run row only when it linked something) looks at activities from the last 14 days with no call linked
  and scores calls within a day that the owner was on or that share the activity's Outlook event id. `decideAutoLinks()`
  is pure and tested: the same calendar meeting links (`calendar_event`); otherwise exactly one candidate at 40+ and that
  one at 85+ links (`auto`); a call two activities both want, or one already linked elsewhere, is left as a suggestion.
  Unlink inserts `gong_link_dismissals` (migration 0176) and a manual link deletes it, so auto-link never undoes a person.
  `POST /api/webhooks/gong` (`routes/gongWebhook.ts`, raw body, skipped by json-body and CSRF, 404 until a key is saved)
  verifies Gong's JWT with node crypto: RS256 only, signature, `exp` (refused if more than a day ahead), `body_sha256`
  against the raw body, `webhook_url` path; receipts keyed by a SHA-256 of the token (`gong_webhook_receipts`, one day)
  stop replays. The body is used only for the call id; the call is re-read via `/v2/calls/extensive` (selected workspaces
  only), indexed and auto-linked. Gong card: Link calls automatically (default on) and the webhook URL + public key
  (PEM or bare base64, must be RSA), `PUT /api/admin/integrations/gong/linking`, audited `integration.gong.linking`.
  `GET /api/gong/week` returns the caller's own recorded Outlook events and linked activities for the "Recorded in Gong"
  chip and "Gong call" badge. Also fixed a phase 2 bug: raw SQL used `${array}::text[]`, which drizzle renders as
  `($1, $2)::text[]` (or `()` when empty), so every Transcripts route that resolved identities failed; `textArray()` now
  builds `ARRAY[...]`, covered by new pglite route tests. Still unverified without a Gong tenant: the webhook payload
  shape (`callData.metaData.id`, `isTest`) and the claim names, taken from Gong's help center. Auto-link only runs on a working
  Gong connection: the job waits as Not set up without one, `runGongAutoLink()` returns early, the card reads it as off
  and the settings route answers 409.
- **v1.456.1 — Month calendar click opened the previous week on Sundays.** In Sunday-first mode (the default), the month
  calendar's `onDayClick` measured the clicked week from `startOfWeek(today, Sunday)`, while `useActivities` measured
  week offset 0 from `startOfWeek(today, Monday)`. Those agree six days a week and differ by one week when today is a
  Sunday, so every click landed a week early, and offset 0 itself showed the week before today. One mapping now serves
  all three callers (`src/shared/weekNav.ts`: `canonicalWeekStartFor()`, `weekOffsetForDate()`): a Sunday belongs to
  the Monday week after it in Sunday-first mode. Used by `useActivities` (new `weekStartsMonday` argument), the month
  calendar click, and the `?startDate=` deep link, which had the same Sunday bug. `weekStart` stays Monday-anchored.
- **v1.456.2 — Sunday-first weeks load the days they show.** With weeks starting on Sunday, `useActivities` fetched the
  canonical Monday week, so the list's first Sunday never had activities and the trailing Sunday was fetched and counted
  in the capacity bar but shown in the next week. The hook now sends the displayed week start
  (`displayWeekStartFor()`), and `GET /api/activities` ends the window 7 days after the start it was given instead of
  `endOfWeek(..., Monday)`, which also ran in the server's timezone and ended the week on Sunday afternoon for clients
  west of UTC. The capacity bar, Weekly capacity and Activity Types pies get `displayWeekStart`, and
  `useWeeklyCapacity()` reads the `work_days` bit by real weekday (`workDayBit()`, `src/shared/weekNav.ts`) rather than
  position in the week. `weekStart` itself stays Monday-anchored; leader dashboards and capacity jobs are unchanged.
- **v1.457.0 — AI Notes tab (Gong plan, phase 4).** New `activity_ai_notes` AI feature, called only through `runAi()`,
  which now takes a `teamId` that lands on the new `ai_requests.team_id` (migration 0177) so a team's monthly spend can be
  summed (`teamSpentThisMonthUsd()`). Tables `activity_ai_notes` (one per activity: provider, model, input hash, the Gong
  calls read, `used_private_notes`) and `activity_ai_note_items` (section, text, verdict / owner / MEDDPICC key, citations
  jsonb, `to_review` | `kept`, reviewer, `copied_note_id`). `services/aiNotes/generate.ts` reads the linked transcripts
  (when Gong is connected) and only the owner's own notes; calls are labelled C1/N1 and the AI cites "C1@12:03" / "N2",
  mapped back to call id + offset or note id by `prompt.ts`. A transcript over 120k characters is condensed in chunks of
  whole Gong topics first (at most 10 chunks), then the note is written from the chunk summaries. The team limit is checked
  before every call. Regenerate deletes `to_review` items and tells the AI not to repeat kept ones. Read rule
  (`services/aiNotes/access.ts`): owner and App Admins always; anyone `canReadTranscript()` allows for a linked call or via
  the leader switch, unless the note read a private note (sticky while kept items remain). Only the owner generates,
  keeps, removes and copies. Routes `/api/ai-notes/*` (tab state, generate rate-limited to 6/min, keep, keep-all, remove,
  copy-to-notes, `/settings`), team settings on Admin → Workplace → AI Notes (`/api/admin/teams/:id/ai-notes`; switch and
  sections for Team Admins, limit App Admin only, audited `team.ai_notes.update`). Role Management keys
  `activities.ai_notes` and `admin.ai_notes`. Unreviewed items written from a transcript are culled with the transcript
  cache period (housekeeping step and a `RETENTION_POLICIES` row, so App Health checks it). Never pushed to the CRM.
- **v1.458.0 — AI Notes on My Notes (Gong plan, phase 5).** A Written / AI switch in the My Notes header (shown when
  the caller has the `activities.ai_notes` key and a team with AI Notes on, or already has AI Notes). `GET
  /api/ai-notes/mine?q=` returns one row per AI Note on the caller's own activities (teams whose switch is on, the rule
  that shows the drawer tab), with to-review and kept counts; search covers the activity title, linked record names and
  item text (LIKE wildcards escaped). The AI list reuses My Notes' grouping (Opportunity / Account / Campaign / Lead, or
  Organize by Account), sort and expand controls, with a to-review count on each group and a "to review only" filter. The
  right pane renders `AiNotesTab` itself (new `onViewChange` prop keeps the list counts in step), so Keep / Remove /
  Keep all / Regenerate / Copy to Notes are the same code as on the activity. Teammates' AI Notes are not listed here.
- **v1.459.0 — Gong calls, transcripts and AI Notes in Demo Data.** Generate (and Reseed) now seeds sample Gong calls on
  the demo team's recent (last 6 weeks) Opportunity/Account meetings: about 60% of the admin's and 20% of the team's
  get a linked call (calendar, auto or manual link), up to six more per group stay unlinked so the Transcripts tab
  suggests them. Each call gets a scripted transcript (Discovery, Demo, evaluation, executive briefing or check-in,
  named after the account, with fictional AE and customer contacts on `.example` domains) written straight into
  `gong_transcript_cache`, and many get an AI Note (`model: 'Demo sample'`, no provider) whose items cite transcript
  moments and the owner's notes, in three review states: all to review, partly kept, or reviewed with one or two items
  removed. The demo team gets AI Notes and "Leaders can read transcripts" on. Without a Gong connection the tabs show for
  demo-team activities only (`GET /api/gong/status?activityId=`, `gongReadinessForTeam()` in `services/gong/demo.ts`);
  a demo transcript is read from the cache and never fetched; suggestions, search and linking never mix demo and real
  calls; the transcript and AI Note item culls, a Gong disconnect and auto-linking leave demo rows alone; and Generate
  answers `errors.ai_notes.demo_data` for the demo team, so no AI is spent. Remove Demo Data deletes the calls and
  transcripts (links and AI Notes go with the activities).
- **v1.460.0 — Transcripts icon on activity cards; wider activity drawer.** A Transcripts icon (MessageCircleText) sits right
  of the Notes icon on each activity card: gray with no linked Gong call, blue with a count when one is linked
  (`gongCallCount` on `GET /api/activities`, one GROUP BY over `activity_gong_calls`, like `notesCount`). It shows only
  when the team's Gong readiness and the Transcripts grant allow it (`GET /api/gong/status?teamId=`, the same
  `gongReadinessForTeam()` rule as the drawer tab, so the demo team uses demo calls). Clicking it opens the drawer on
  Transcripts (`ActivityForm` `initialTab`); every open now starts on the requested tab instead of the last one used.
  The drawer is `max-w-[52rem]` (was `max-w-xl`) so all five tabs fit on one line in every locale (widest, es/pt, measure
  ~735px); narrower screens scroll the tab row and keep the open tab in view.
- **v1.460.1 — No stray scrollbar on the activity drawer's tab row.** v1.460.0 made the tab row `overflow-x-auto`, which
  also makes overflow-y auto; the tabs' `-mb-px` underline overlap then overflowed by 1px and Windows drew a vertical
  scrollbar (up/down arrows). The baseline is now an inset box-shadow (no overlap), the row is `overflow-y-hidden`, and
  the scrollbar is hidden; the row still scrolls sideways on a narrow screen.
- **v1.461.0 — AI Assessments (part 1: setup).** New Admin → Activities & Rules → AI Assessments
  (`AiAssessmentsConfig.tsx`, `routes/admin/aiAssessments.ts`, migration 0178), chosen as option B of the placement
  pitch: rubrics and their assignments live together on one team-scoped page, not in AI Assistant, because Team Admins
  own Activity Types and Subtypes. Tables `ai_assessments` (+ `ai_assessment_teams` sharing junction, like Keyword
  Rules), `ai_assessment_criteria` (weight 1–100, anchors per 1–5 level) and `ai_assessment_assignments` (team, type,
  Subtype or null, max 3 per row). Sharing or unsharing needs admin rights on each team; unsharing deletes that team's
  assignments; only App Admins lock. Rubric edits bump `version` so later scores can record which rubric they used.
  `computeAssessmentScores()` / `resolveAssessmentIds()` (`src/shared/aiAssessments.ts`) are the scoring and
  "Subtype rows win, else type-wide rows" rules for part 2. The owner's decisions: two scores (not-observed zeroed, and
  observed-only with the not-observed count), scores for Leaders only with a dashboard, personal sections stay,
  assessments run only when a transcript was read. Workplace → AI Notes became the Settings tab (`?section=ai_notes`
  redirects; Role Management key `admin.ai_notes` kept). Also: AI Notes tab sections are color-coded
  (`AI_NOTE_SECTION_STYLES`), collapsible (remembered in localStorage) and show item / to-review counts.
- **v1.462.0 — AI Assessments (part 2: scoring).** New table `activity_ai_assessment_scores` (migration 0179): one row per
  activity and rubric with a snapshot (name, version, per-criterion weight / level / rationale / citations), both scores
  (`zeroed_score`, `observed_score` + `not_observed_count`), the Gong call ids, provider and who ran it; a rerun replaces
  the row. `services/aiAssessments/score.ts` resolves the rubrics (`assessmentsForActivity()`: assignment, still shared
  with the team, active) and scores them in ONE AI call (new routable feature `activity_ai_assessments`); the AI returns
  only a level per criterion (null = not observed) and ImpactIQ computes the scores. AI Notes Generate scores right after
  writing the note, only when a transcript was read, reusing the same (possibly condensed) transcript text; the owner's
  notes are not sent, and a scoring failure never fails the AI Note. `loadTranscriptCalls()` / `condenseTranscripts()`
  were pulled out of `generateAiNote()` for this. Visibility is `canSeeAssessmentScores()`
  (`services/aiAssessments/access.ts`): never the owner (even an App Admin owner), otherwise App Admins, or a
  leader/team_admin/admin of the activity's team (or one with can_see_all_teams) holding the new
  `activities.ai_assessments` grant (leader + team_admin on by default, contributor off). Routes `/api/ai-assessments`
  (GET view, POST run, 6/min). Drawer gets an Assessments tab (`AiAssessmentsTab.tsx`). Leader dashboard is part 3.
- **v1.463.0 — AI Assessments (part 3: Leader dashboard).** The **AI Assessment Scores** dashboard (Health group, tab key
  `aiAssessments`). `GET /api/dashboards/ai-assessments` reads `activity_ai_assessment_scores` for submitted, non-archived
  activities in scope (date window, people, products), always leaving out the caller's own activities (nobody sees scores
  on their own calls). Teams go through `assessmentScoreTeamIds()` (`services/aiAssessments/access.ts`, sharing
  `callerGrant()` with `canSeeAssessmentScores()`), so the `activities.ai_assessments` grant is needed as well as
  `dashboard.aiAssessments` (migration 0180: leader + team_admin on, contributor off). `summarizeAssessmentScores()`
  groups by assessment (a deleted one stays under its stored name), averages both scores and the not-observed count, and
  averages criterion levels from the rubric snapshots (names from the newest score; observed rate per criterion). The
  page shows KPIs, By person, By criterion and the latest 100 scored activities, flagging scores from an earlier rubric
  version. `scoreTone()` moved to `lib/assessmentTone.ts`.
- **v1.464.0 — AI model lists and prices; AI Assessments in export/import and Demo Data.** `POST /api/admin/ai/models`
  (App Admin, read-only, not audited) lists models from the provider's own API with the typed or saved key (Anthropic,
  OpenAI, Gemini, xAI; fixed hosts), else the current models in the LiteLLM price list
  (`services/ai/modelCatalog.ts`, downloaded from GitHub, cached 12 h, 10 min back-off after a failure), else the
  built-in suggestions. Each model is priced from LiteLLM (Bedrock prefers the Mantle price) or the built-in table. The
  form fills blank or previously auto-filled price fields; a typed price turns that off and is what gets saved. The owner
  chose LiteLLM as the price source. Activity Types export gains an optional `aiAssessments` section
  (`services/aiAssessments/transfer.ts`): match by name among assessments shared with the team, shared or locked ones
  skipped (locked editable by App Admins), rubric changes bump the version, assignments only added (cap 3 per slot).
  Demo Data seeds three rubrics on the demo team and scores linked-call activities (`services/demo/assessmentFixtures.ts`);
  Remove deletes the demo team's rubrics first.
  Also on the AI Assistant page: provider marks (`AiProviderLogo.tsx`, Simple Icons paths, CC0; Azure OpenAI shows the
  OpenAI mark and Foundry the Anthropic mark, as Simple Icons has no Microsoft mark), header icons on Providers and
  Usage, and the routing card shows with one active provider as a hint instead of being hidden (the owner couldn't find
  per-feature routing). `isAiProviderKind()` moved to `src/shared/ai.ts`.
- **v1.465.0** — AI Assessments page cleanup (the owner's review of the three tabs). Assessments are collapsed cards
  (chevron, icon, name, badges, quick Edit) and expand to the criteria list; `ai_assessments.icon` / `icon_color`
  (migration 0181, cosmetic so no version bump) come from the shared IconPicker / ColorPicker and travel in the
  Activity Types export (optional keys; a file without them leaves the icon alone). In the editor each criterion is a
  collapsed row (drag handle via dnd-kit, number, name, weight share, arrows, delete); the one just added opens, Save
  with an incomplete criterion opens it. Score levels are folded inside an open criterion. Assignments is one tinted
  row per Activity Type (its color at 16%, Subtypes at 6%, collapsed by default with an "n subtypes, m with their own"
  toggle). Cards on all three tabs use `bg-white dark:bg-gray-900`. AI Assistant Feature routing shows the icon of the
  page or tab each feature lives on. Demo rubrics get icons. Checked in a browser harness with mocked API, light and dark.
- **v1.466.0** — AI Note Settings Profiles (AI Assessments → Settings, migration 0182). `ai_note_profiles` (team-owned:
  name, description, icon, color, built-in `sections`, `custom_sections` jsonb of `{key: "c_…", name, instructions, icon,
  color}`), `ai_assessments.ai_note_profile_id` (set null on delete), `activity_ai_note_items.section_meta` (a custom
  section's name/icon/color when written, so items survive the profile changing). The owner chose "profile adds to personal
  sections": `sectionPlanForActivity()` (`services/aiNotes/profiles.ts`) merges the owner's sections with the profiles of
  every assessment that runs on the activity (same assignment rules as scoring), built-ins in canonical order then custom
  sections. Prompt lists each custom key with its instructions, the JSON schema enum is built per call, the parser keeps
  custom items as text + citations only. Routes `/api/admin/teams/:teamId/ai-note-profiles` (Team Admin, audited
  `ai_note_profile.*`, delete destructive); an assessment can only pick a profile from the team that owns it. Not in this
  release: personal/team default sections stay built-ins only, and profiles are not in the Activity Types export.
- **v1.467.0** — AI Assistant Usage this month reorganized (the owner's ask). `GET /api/admin/ai/usage?groupBy=feature|team|user
  &feature&teamId&userId&page` (App Admin, `services/ai/usage.ts`): this month's `ai_requests` grouped (requests, failed,
  tokens, cost, sorted by cost) plus one 20-row page of requests with team and person, and the filter choices seen this
  month. A request's team is `coalesce(ai_requests.team_id, requester.default_team_id)`; `none` filters requests with no
  team or no person (jobs, tests). The 50-row `recent` list on `GET /api/admin/ai` was removed. Panel is
  `components/admin/ai/AiUsagePanel.tsx`; shared bits (feature icons, `usd`, status pill) moved to `aiUsageShared.tsx`.
- **v1.467.1** — Keyword rule scope across teams. A rule is one row shared through `keyword_rule_teams` but stores one
  team's `activity_type_id`, so sharing it to another team showed the id there, `matchKeywords()` skipped it, and the
  team's own rule for that type stayed beside it. New `services/keywordRules/scope.ts`: a rule's type resolves per team
  (stored id if visible, else the team's type of the same name) in the admin list and `matchKeywords()`; a save refuses a
  team with no such type (`errors.keyword_rules.type_missing_in_teams`); and a save replaces, on every other team in the
  scope, a rule it fully covers (same action and type, keywords a subset, match field covered; reported in
  `meta.replaced`). Team Admins can only add or remove teams they can see. `deleteTeamCascade()` moves a shared rule to a
  remaining team (`detachKeywordRulesFromTeam()`), and team duplicate remaps a shared-in rule's type by name.
- **v1.468.0** (2026-11-03): Per-feature AI switches. `ai_settings.disabledFeatures` (`AiFeature[]`, `isAiFeatureOn()` in
  `src/shared/ai.ts`) is set from the AI features card on AI Assistant (always shown, formerly Feature routing; the
  provider picker still appears only with 2+ active providers). `aiAvailability()` and `runAi()` answer a turned-off
  feature as `disabled`, so every caller already falls back to its no-AI path, and nothing is logged to `ai_requests`;
  `aiNotesSwitchedOn()` checks it too. Asked by the owner, who wanted Activity type suggestions on keyword rules only. Also
  fixed: the weekly calendar's AI classification (`routes/outlook.ts`) never passed `requestedBy`, so its requests
  showed as No team / no person in Usage; it now charges the calendar's owner (team via their default team; `team_id`
  stays unset so AI Notes' per-team limit doesn't count classification).
- **v1.469.0** — My Settings → Timezone can be set by hand (an IANA list, UTC first) with no Outlook or CRM connected.
  New `users.timezone_source` (`auto` | `crm` | `manual`, migration 0183) and `users.outlook_timezone`: the hourly
  mailbox check (`maybeRefreshUserTimezone()`) always refreshes `outlook_timezone` but only changes `users.timezone`
  while the source is `auto`, so a CRM or manual pick sticks (before, the check reverted a Salesforce pick within the
  hour). Connecting Outlook sets the source back to `auto` (Outlook takes precedence, banner as before); disconnecting
  clears `outlook_timezone` only. `GET/PATCH /auth/me/timezone` read and set it (`auto` uses the stored mailbox zone;
  `crm`/`manual` must be a zone Intl knows). The CRM row reads `GET /api/crm/me/tz` (`services/crm/timezone.ts`): the
  user's Salesforce `TimeZoneSidKey`, or the HubSpot portal's `timeZone` from `/account-info/v3/details` (cached 1h; no
  per-owner timezone in HubSpot's API), and is hidden with no CRM. Wording uses `{{crm}}` with `_none` variants.
- **v1.470.0** — User Management's Subteams picker loaded every team (`GET /api/admin/teams`) and every subteam of each,
  so a user only on [Demo] Sales Engineering was offered Solutions Engineering's Leadership. It now reads
  `GET /api/admin/users/:userId/subteam-options` (`services/teams/userSubteams.ts`): active subteams of the user's teams,
  meaning `team_members` rows plus the default team. `PUT .../subteams` refuses a subteam outside those teams
  (`errors.subteams.not_user_team`) unless it is already assigned, and `GET .../subteams` flags such rows
  `outsideTeams`; the picker shows them in an amber group to remove. Leaving a team (team member delete, or Edit user's
  supported/default team change) drops that team's member-role subteam rows; subteam leader rows are untouched.
  Existing stale rows are not deleted in bulk: they show in the amber group for an admin to decide.
- **v1.471.0** — Default Settings Profile. The owner asked for the team's AI Note default sections to be a profile so it can
  be replaced or turned off more easily, and chose a per-profile Add or Replace switch. Migration 0184 adds
  `ai_note_profiles.is_default` (partial unique index, one per team) and `combine_mode` (`add`|`replace`, default `add`),
  and gives every existing team a "Default" profile holding its saved default sections (all built-ins when it had none).
  Sections now resolve as: the person's own (My Settings), else the Default profile (built-in and custom), else every
  built-in; then each assessment's profile is added, and a Replace profile drops the default (`resolveSectionBase()` /
  `mergeProfileSections()` in `src/shared/aiNotes.ts`). A person's own sections are never replaced, keeping the
  v1.466 decision that sections stay personal. `PUT /api/admin/teams/:teamId/ai-note-profile-default` moves or clears
  the star; the AI Notes settings page lost its Default sections editor (`defaultSections` is no longer accepted), and
  `teams.ai_notes_default_sections` stays in the schema unread. New teams start with no Default profile (every
  built-in), and the Settings Profiles card says so.
  Same release: the AI features card on AI Assistant shows, for every feature, what it does and where (`feature_about`)
  and what happens when it's off (`feature_off_effect`), after the owner asked what turning each one off does. New
  `GET /api/ai/features` (`routes/ai.ts`) returns `aiAvailability()` per feature without calling a provider; My Notes
  uses it to hide AI Organize and Ask My Notes when they're off (they used to stay and fail on click). The AI Organize
  tooltip no longer names GPT-4o.
- **v1.471.1** — Outlook Windows timezone names converted to IANA ids. Graph's mailboxSettings usually answers with a
  Windows name ("Pacific Standard Time"), which Intl rejects, so digest / weekly recap / nudge working hours ran on UTC
  and the client's `lib/tz.ts` could throw. `normalizeTimeZone()` (`src/shared/windowsTimezones.ts`, CLDR windowsZones
  territory 001) is applied where the Outlook timezone is written (hourly refresh, connect callback) and in the client's
  `resolveTZ()` (unknown values fall back to the browser zone). Stored values are rewritten once per boot by
  `normalizeStoredTimezones()` (in code, not a migration, so the mapping has one copy).
- **v1.472.0** — User and Team edit forms regrouped. The owner found the User Management edit/new-user form and the Team
  Management edit form one long, unmarked list, so three layouts were pitched (in-place collapsible sections, a side
  drawer with tabs, a section rail with cards) and he picked the first. New `components/admin/FormSection.tsx`:
  `FormSection` (colored icon chip, title, one-line summary shown while closed, required status pill),
  `useFormSections()` (open/closed per section, remembered in localStorage per form, Expand all / Collapse all),
  `FieldLabel` (red `*` or "optional"), `FormSubheading` and `FormSaveBar` (names the empty required fields). User
  edit: Profile, Access & sign-in, `{{crm}}` link, Subteams, Work week, Preferences & notifications; new user:
  Profile & sign-in, Team & access, Work week, Welcome email; team edit: Identity, People & `{{crm}}`, Theme,
  Notifications, Work Week Defaults, Subteams. A section with an empty required field is forced open. The edit form
  now has the user's role on the current team (flat team view only; the grouped All Teams view keeps the row
  dropdown), saved after the user PATCH through the same role route as the row dropdown. The hourly cost note links
  to `/admin?section=cost_groups`, and the team form's Work Week Defaults heading no longer shows twice
  (`WorkWeekDefaults bare`). Same save payloads, no API or schema change.
- **v1.472.1** — The v1.472.0 User and Team edit forms capped at `max-w-5xl`, which left a wide empty band on large
  screens; the owner asked for them to fill the width. The cap is removed from the edit user, new user and edit team forms;
  section layouts are unchanged.
- **v1.473.0** — Demo Data seeds AI Note Settings Profiles (`services/demo/profileFixtures.ts`): a starred Default
  profile with every built-in section, plus Discovery Deep Dive and Demo Follow-up (Add) and Evaluation Checkpoint
  (Replace: summary, checked, next steps, risks and a Success criteria status section), each set as its sample AI
  Assessment's profile. The demo AI Notes carry items in those custom sections (with `section_meta`), and the
  evaluation note no longer has a MEDDPICC section since its profile replaces the default. Profiles go with the demo
  team (cascade). Same release: the owner asked to remove the activity card's "Gong call" badge, which repeated the
  Transcripts icon; the badge, the card's `gongLinked` prop and the `activity.gong.linked` / `linked_hint` strings are
  gone (`/api/gong/week` still returns `linked`, now unused by the weekly view).
  Also in v1.473.0: the owner saw four "Activity type suggestions" requests for one person's calendar and asked for one
  request covering all their unmatched meetings, with a count. `classifyManyWithAI()` (`services/ai/classify.ts`)
  answers cached meetings from `ai_classification_cache` (same per-meeting hash as before), sends the rest in one
  request (40 per request at most, `CLASSIFY_BATCH_SIZE`) and caches each answer; a meeting the answer leaves out is not
  cached, so the next sync asks again. `GET /api/outlook/suggestions` now runs the rules per meeting first and then one
  batch. `ai_requests.item_count` (migration 0185, null = one item) records how many items a request covered, shown as
  the Items column on Usage → Requests. `classifyWithAI()` is now a one-item batch.
- **v1.473.1** (2026-11-14) Public-release prep, part 1. Apache-2.0 `LICENSE` + `NOTICE`, `"license"` in package.json.
  Scrubbed the first deployment's organization name and data: comments in migrations 0007/0018/0071/0092, 0112 no
  longer seeds two of that org's Salesforce automation user ids into `crm_historical_exclusions` (existing installs keep
  their rows; the migrator keys on journal timestamp, so editing old migration text never re-runs a file), 0149 seeds
  the fresh-install theme as `Default` and reads `brand_palette*` keys (no install still holds the old keys: the palette
  was retired before 0149 shipped everywhere), and 0152 becomes a `SELECT 1` no-op. Org-specific figures removed from
  README, PRD, CLAUDE.md and docs. New `scripts/check-banned-terms.py` (CI step) fails on any banned name; it stores
  only SHA-256 hashes and matches inside identifiers and email domains.
- **v1.474.0** (2026-11-14) Public-release prep, part 2: Salesforce SE fields from CRM Field Mappings. The default
  Opportunity search hardcoded `Assigned_SE__c`/`Primary_Engineer__c`/`Specialist_Engineer__c`/`Supporting_Engineers__c`,
  so it failed with INVALID_FIELD on any other org. Now `OwnerId` OR every active `opp_se_filter` mapping on Opportunity
  (`services/salesforce/seFilter.ts`): describe (cached 10 min per org) drops fields the org lacks or of an unusable type;
  lookup/Id/text compare the User Id, picklists and multi-selects also the user's display name. No linked user and no
  picklist to match = no results. The Assigned SE picker's routes lost their `Assigned_SE__c` fallback (unmapped =
  `meta.configured: false`, PATCH 409) and read the SE filter fields when the write field is empty. Attach Rate's Primary
  tier prefers the scope teams' `assigned_se_write` field. Migration 0186 maps the old fields for every team on installs
  where someone connected Salesforce and the CRM isn't HubSpot/None. Validation allows several `opp_se_filter` rows and
  type-checks them; CRM Field Mappings shows a hint (create a Lookup(User) field on Opportunity) until one is mapped.
- **v1.475.0** (2026-11-14) First-admin bootstrap. The `/setup` wizard only runs while `DATABASE_URL` is unset, so an install started
  with it set (Docker Compose, any orchestrator) came up with no users and no way to create one. While the users table is
  empty the server now prints the setup token at boot, `App.tsx` shows `pages/FirstRun.tsx` instead of Login (via public
  `GET /api/first-run/status`), and `POST /api/first-run/admin` (needs `X-Setup-Token`, CSRF-protected) creates an App
  Admin who is also the default admin, seeding the default team first if there is none. `createFirstAdmin()` re-checks for
  any user under `pg_advisory_xact_lock`, so racing requests can't both get through, and the route 409s for good once a
  user exists; the creation is audited as `user.create` with `source: 'first_run'`. The setup wizard's create-admin now
  also sets `is_default_admin` when no default admin exists. How to Use's `overview_body` was retranslated in the six
  non-English locales to match the current English text.
- **v1.476.0** (2026-11-16) Safe defaults for a public repository. `requireSecret()` (`services/config/env.ts`) treats a
  value starting with `change-me` (`isPlaceholderSecret()`) as unset, so a copied `.env.example` refuses to start in
  production instead of running with a published secret. `.env.example` no longer sets `NODE_ENV=development` (which
  overrode the image's production mode) and leaves `POSTGRES_PASSWORD` empty; `docker-compose.yml` requires it
  (`${POSTGRES_PASSWORD:?...}`) and binds Postgres to `127.0.0.1:5432`. Added SECURITY.md (private vulnerability
  reporting), CONTRIBUTING.md, issue and pull request templates, and `.github/dependabot.yml` (npm, Actions, Docker).
- **v1.477.0** (2026-11-16) SSRF hardening. `assertPublicHttpsUrl` / `assertServiceUrl` resolved and checked a host, then
  a separate `fetch()` resolved it again (a DNS-rebinding window), and most callers followed redirects. New `safeFetch()`
  (`services/net/safeFetch.ts`) runs the same up-front check, then connects through undici `Agent`s whose `lookup`
  re-checks every address (public only; or, with `allowPrivateNetwork`, anything but loopback/link-local/reserved, and
  plain http only to a private address), always with `redirect: 'manual'`. Used by the Slack nudge webhook, event
  webhooks, the AI webhook provider, CriteriaIQ, Okta discovery/token/userinfo, JWKS, Salesforce token exchange and
  refresh, the Salesforce identity lookup (now also limited to Salesforce hosts), the setup wizard's Okta and Salesforce
  tests (the Salesforce test now uses the Salesforce host rule) and the Admin Okta/Salesforce tests. It uses undici's own
  `fetch` (added as a direct dependency) because Node's bundled fetch rejects an undici 8 dispatcher. `isPrivateAddress()`
  now judges IPv4-mapped IPv6 as IPv4 (`[::ffff:127.0.0.1]` used to pass as public) and treats 100.64.0.0/10 as private.
- **v1.477.1** (2026-11-16) i18next 26 → 27 and react-i18next 17 → 18 (replaces Dependabot PR #711, which failed the client
  typecheck). i18next 27's `TFunction` no longer accepts an options argument that may be `undefined`, so helpers that took
  `t` as `(key, opts?) => string` (`translateServerError()`, `reasonLabel()`, `formatLastActivity()`, the CRM Field
  Mappings import modal) now take `TFunction`, and FlightDeckModal calls `t()` once per branch. Runtime changes checked and
  not hit: we set `fallbackLng: 'en'` and `supportedLngs`, no locale value is `''` (empty strings now fall back), there is
  no `Trans`, `returnObjects`, `withTranslation` or `useSSR`, and `escapeValue` is already `false`.
- **v1.478.0** (2026-11-16) Public-release prep. New `.github/workflows/codeql.yml` (javascript-typescript,
  `security-extended`, on pull requests, pushes to `main` and weekly). Every Action in CI and CodeQL is pinned to a
  commit SHA with the version in a comment, which Dependabot's `github-actions` updates keep current. CI's migration job
  moved from Postgres 16 to 18 to match `docker-compose.yml`. Added `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and
  `THIRD_PARTY_NOTICES.md` (npm packages, the Simple Icons AI provider marks, Lucide, images). The README's Deployment
  section now covers the reverse proxy and TLS (`APP_URL`, trusted proxy hops, `/ready`), external Postgres, backups
  (`pg_dump` plus keeping `TOKEN_ENCRYPTION_KEY`) and upgrades. The hono advisory was already fixed by #715
  (hono 4.13.18). gitleaks 8.28.0 and trufflehog 3.90.0 over the tree found only test fixtures and placeholder
  connection strings.
- **v1.479.0** (2026-11-17) `POST /api/v1/effort/project-activities` lists the activities behind one CriteriaIQ
  project's count for CriteriaIQ's Activities drawer: type (with its icon and color), the person who logged it, hours, start and end, and whether
  it came in only through the Opportunity fallback. Newest first, at most 500, never titles, notes or cost. The matching
  moved into one `matchProjects()` (`services/activities/projectActivityCounts.ts`) that both `project-counts` and the
  list use, so they always agree. CSRF-exempt like `project-counts` (Bearer keys only).
- **v1.479.1** — Fresh-install fixes found while testing the public snapshot. The production image crashed at boot with
  `ERR_MODULE_NOT_FOUND` for `@anthropic-ai/sdk`: since the November 16 dependency update npm keeps that package nested
  in `src/server/node_modules`, which the production stage never copied. The Dockerfile now copies it to
  `dist/server/src/server/node_modules` (and creates the folder in the build stage so the COPY never fails).
  `docker-compose.yml` mounted Postgres at `/var/lib/postgresql/data`, which Postgres 18 images refuse, so the bundled
  database never started; it now mounts `/var/lib/postgresql`. CI gained a "Fresh install (docker compose)" job that
  builds the image, starts the stack, waits for `/ready` and checks the first-run status and setup token.
- **v1.480.0** (2026-11-20) Activities page nudges render as one stacked card (`WeeklyView.tsx`) instead of a vertical
  list: an "N of M" count with previous/next arrows on the left, one or two cards peeking out underneath when there are
  more, and Mark read / Snooze removing the current nudge so the next takes its place (index clamped when the list shrinks).
- **v1.481.0** (2026-11-24) `POST /api/v1/activities/log` (`routes/activityLogApi.ts`, `services/activities/externalLog.ts`,
  contract in `docs/activity-log-api.md`): another tool logs an activity for a user named by email, always as a draft,
  so the person confirms it and links the CRM record before write-back runs. New `activities:log` key scope, minted and
  used only by App Admins (checked on every call), refused by `/api/*` and `/api/mcp`, CSRF-exempt like the effort
  POSTs. `activities.external_ref` (migration 0187, partial unique index) holds the caller's id, so a retry returns the
  first activity instead of logging twice. Audited as `activity.log_via_api`. DemoIQ is the first caller.
