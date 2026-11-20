# App Updates Phase 3 — Host-Side Polling Deploy Agent (design doc, not built)

> **Status: planned, not implemented.** This is a design/architecture document for a future
> feature — see CLAUDE.md's Deferred/Roadmap ("App Updates: automatic redeploy") for the current
> pointer to this file. Nothing described below exists in the codebase yet. When implementation
> starts, follow the phased build order in this document (3a → 3b → 3c → 3d) and update this
> file's status line, or move its content into CLAUDE.md §18 as each phase ships, matching how
> Phase 1 and Phase 2 of App Updates were documented.

## Context

App Updates Phase 1 (read-only "is there an update, what changed") and Phase 2 (scheduled
self-restart) are both shipped. Phase 2's self-restart deliberately only brings the SAME running
image back up — getting a genuinely NEWER version live still requires a human to pull code,
rebuild, and swap the container by hand. The user asked why the app can't just update itself.

We researched two ways to close that gap and rejected both as something to build reflexively:
mounting the Docker socket into the app's own container (equivalent to root on the host — any bug
in the app becomes a bug in the whole host), or committing to one specific host's proprietary
deploy API (breaks this app's deliberate host-independence, and the user doesn't use the one PaaS
this app happens to also support — Dokploy — so that path is doubly wrong for them).

The design we landed on instead: a small, separate, purpose-built **agent program that runs
outside the app's own container** and **polls** the app for "has the default admin approved a
deploy to a specific commit," rather than the app calling out to trigger one. This means a fully
compromised ImpactIQ process can, at most, write inert "please deploy commit X" data — it can
never itself execute or force a deploy, and it has no way to reach the agent at all (the agent has
no listening port; it only makes outbound polling requests on its own clock). This is the
strongest of the three designs we compared: least privilege, no new vendor coupling, works
identically on a bare Azure VM, plain Docker Compose, or (though the user doesn't use it) Dokploy.

This plan is the product of: (1) direct reads of every relevant existing file in this codebase,
(2) a Plan subagent that cross-checked and detailed the design against those same files, and (3)
two decisions the user made explicitly: **no auto-rollback on a failed deploy** (alert a human
instead), and **plan for both** agent-hosting shapes (bare-host systemd and a Docker sidecar),
deciding which to actually stand up at rollout time.

It is scoped into phases (3a–3d) so each can be reviewed and approved independently, the same way
Phase 1 and Phase 2 were.

---

## Architecture

Two halves:
- **App side** — a "deploy intent" the default admin approves against an exact commit SHA, a
  narrow secret-authenticated API for an external caller to read that intent and report back, and
  admin UI/history to see it. Ships as ordinary changes to the existing ImpactIQ codebase.
- **Agent side** — a new, standalone program, **not included in the app's own Docker image**, that
  polls the app-side API on its own schedule and performs the actual `git checkout <sha>` →
  `docker compose build` → `docker compose up -d` → health-check → report-back sequence using
  host-level access the app itself never gets.

### 1. App-side data model

**Reuse `system_settings` for the intent** (same JSONB pattern as `checkForUpdates.ts` and
`maintenanceWindow.ts` — no migration needed for this part). New key `deploy_intent`, new service
module `src/server/services/updates/deployIntent.ts` mirroring `maintenanceWindow.ts`'s exact
`readSetting`/`writeSetting` shape:

```ts
interface DeployIntent {
  targetSha: string
  targetVersion: string | null   // parsed from that commit's changelog, informational
  approvedAt: string
  approvedBy: string
  approvedByEmail: string | null
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled'
  maintenanceWindowId: string | null   // the linked window's scheduledAt, if any
  claimedAt: string | null
  reportedAt: string | null
  reportStatus: 'ok' | 'error' | null
  reportMessage: string | null
  reportDetail: Record<string, unknown> | null
}
```

Functions: `approveDeployIntent()`, `cancelDeployIntent()`, `getDeployIntent()`,
`markDeployIntentClaimed()`, `markDeployIntentReported()` — same `requireDefaultAdmin`-gated,
overwrite-the-one-current-thing convention `scheduleMaintenanceWindow`/`cancelMaintenanceWindow`
already use.

**`deploy_intent` stays a separate concept from `maintenance_window`**, not a field bolted onto
it — a deploy's lifecycle (approved → claimed → multi-minute build → succeeded/failed) doesn't fit
`MaintenanceWindow.status`'s `scheduled/completed/cancelled`, which `restart_scheduler.ts` owns and
ticks every 15s. The link is one optional field each way: approving a deploy with a scheduled time
also calls the existing `scheduleMaintenanceWindow()` unchanged, and stamps `deployIntentId` onto
the resulting window (new optional field on `MaintenanceWindow`) so `MaintenanceBanner.tsx` can
tell "this restart is also a deploy" without any new banner logic.

**Deploy history gets its own table, not `job_runs`.** `job_runs` rows all trace 1:1 to a
`scheduleJob()`-registered task in this process (confirmed via `scheduler.ts` — the Scheduling
page's "Run Now" button invokes tasks straight from that same registry). A deploy report comes
from an external process with no such registration; forcing it through `job_runs` under a
synthetic `jobKey` risks it showing up (or conspicuously not showing up) on the Scheduling page in
a way nothing there is built to handle. New migration (confirm the actual next free number at
implementation time):

```ts
export const deployRuns = pgTable('deploy_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetSha: text('target_sha').notNull(),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedByEmail: text('approved_by_email'),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull(),   // 'ok' | 'error'
  message: text('message'),
  detail: jsonb('detail'),
})
```

Add `DEPLOY_RUNS_RETENTION_DAYS` to the existing 6h retention-cull sweep alongside
`JOB_RUNS_RETENTION_DAYS` (CLAUDE.md §17) — one more line in an existing job, not a new one.

### 2. App-side auth: a new shared secret, not the personal-API-key table

`apiKeys.userId` is `NOT NULL` (FK to `users`) — it's built for personal, per-user keys, and
inventing a fake "service user" row to satisfy that FK would confuse every place `users` gets
joined (RBAC, audit actor display, team membership). Instead: reuse `apiKeys.ts`'s **cryptographic
shape** (`scryptSync` + `timingSafeEqual` + cleartext prefix for lookup) in a new module,
`src/server/services/auth/deployAgentSecret.ts`, storing the one system-wide secret encrypted in
`system_settings` (key `deploy_agent_secret`) via the existing `encryptToken`/`decryptToken`
helpers — the same pattern Phase 1 already uses for the GitHub PAT, so no new secret-management
surface for the operator.

Raw secret format `iqd_<43 base64url chars>` (distinct prefix from personal `iqk_` keys, so a
leaked deploy secret is instantly distinguishable in logs/incident review). Functions:
`generateDeployAgentSecret()` (shows the raw value exactly once, same "show-once" contract
`ApiKeysSection.tsx` already established — reuse that component's UI pattern verbatim rather than
inventing new copy-to-clipboard chrome), `rotateDeployAgentSecret()` (same call, admin must
manually copy the new value into the agent's own env file — there is no reverse channel for the
app to push it, by design), `verifyDeployAgentSecret()`, `getDeployAgentSecretSummary()` (never
returns the raw value after creation).

New middleware `src/server/middleware/deployAgentAuth.ts`: reads a dedicated header
(`X-Deploy-Agent-Secret`, not `Authorization: Bearer`, to keep it visually and grep-ably distinct
from session/API-key auth), verifies it, 401s otherwise. This is the *only* way into the
agent-facing routes below — a stolen admin session cookie alone can't reach them.

### 3. App-side routes

All new admin-facing routes go in `src/server/routes/admin.ts` next to the existing App Updates
block, following the exact `requireAppAdmin` (view) vs. `requireDefaultAdmin` (mutate) split
already established there:

```
GET    /admin/updates/deploy-intent          requireAppAdmin
POST   /admin/updates/deploy-intent          requireDefaultAdmin   { targetSha, scheduledAt?, message? }
DELETE /admin/updates/deploy-intent          requireDefaultAdmin
GET    /admin/updates/deploy-history         requireAppAdmin
GET    /admin/updates/deploy-agent-secret    requireAppAdmin
POST   /admin/updates/deploy-agent-secret    requireDefaultAdmin   generate/rotate, raw value once
```

`POST .../deploy-intent` validates the SHA is real by calling GitHub's
`GET /repos/{owner}/{repo}/commits/{sha}` with the existing PAT before accepting it (rejects a
typo'd/unreachable SHA rather than silently approving garbage) and audits
`system_update.deploy_approve` via the existing `logAudit(req, ...)`.

Extend `checkForUpdates.ts`'s `UpdateCheckStatus` with `latestSha: string | null`, resolved via
`GET /repos/{owner}/{repo}/commits/{branch}` alongside the existing changelog fetch, so the admin
UI can offer "approve deploy of the version Check Now just showed you" as a one-click default
instead of requiring manual SHA entry.

**A separate, non-session router for the agent itself** — `src/server/routes/deployAgent.ts`,
mounted as `app.use('/api/deploy-agent', deployAgentRouter)` (sibling to the existing
`app.use('/api/mcp', mcpRouter)` mount in `index.ts`), deliberately *not* folded into `adminRouter`
(which assumes `req.user` from session auth throughout — mixing in a secret-header-only route
there is an easy footgun for a future refactor):

```
GET  /api/deploy-agent/intent    requireDeployAgentSecret + rateLimit   -> pending DeployIntent | null
POST /api/deploy-agent/claim     requireDeployAgentSecret + rateLimit   { targetSha } -> in_progress
POST /api/deploy-agent/report    requireDeployAgentSecret + rateLimit   { targetSha, status, message, detail }
```

`GET /intent` only ever returns an intent whose `status === 'pending'` — an already-claimed or
resolved one returns `null`, so a second agent polling the same intent naturally sees nothing to
do. `POST /claim` is a second, independent guard against a duplicate build (409s if the intent is
already claimed). `POST /report` writes `deploy_runs`, updates the intent's terminal state, and
calls `logSystemAudit({ action: 'system_update.deploy_report', ... })` — no `Request` exists for
this call, same as the existing `restart_triggered` audit row.

Rate limiting: a dedicated `rateLimit({ windowMs: 60_000, max: 20 })` (or similar) ahead of the
secret check on all three routes, matching the existing `oidcLimiter` convention for
unauthenticated-until-proven-otherwise endpoints in `routes/auth.ts`.

### 4. Coordination with the existing restart-scheduler

**`restart_scheduler.ts` keeps its unconditional self-exit at the scheduled instant, unchanged —
no new branch for "a deploy is also pending."** Making it skip its own exit "because the agent
will handle the restart" would create a real ordering dependency (old code keeps serving until the
agent's multi-minute build finishes) with a bad failure mode: if that build fails, nothing ever
restarts and the maintenance window silently sits `scheduled` past its due time — worse than
today. Self-exiting regardless is strictly safe: if the agent isn't done yet, `restart:
unless-stopped` just brings the OLD image back for a few extra seconds until `docker compose up
-d` replaces it. Worst case is one harmless extra restart-of-the-old-version, not a correctness
problem.

This also settles who marks the window `completed` and when: **`restart_scheduler.ts` (the OLD
process) does, exactly as it does today, independent of whether the deploy itself later
succeeds.** "The announced downtime window happened" and "the deploy succeeded" are different
facts — the former is `maintenance_window.status`, the latter is `deploy_intent.status` +
`deploy_runs`, reported later (possibly by the NEW process, since the agent's build can easily
outlast the old process's own restart) via the independent `POST /report` path.
`MaintenanceBanner.tsx`'s post-restart confirmation should say "the app restarted," not "you're
updated" — the real deploy outcome surfaces separately once the agent reports it (see admin UI
below).

### 5. Client-side changes

**`GithubUpdatesForm.tsx`** — new "Deploy" section below the existing Scheduled Maintenance
section, same card, same `canAct = user?.isDefaultAdmin` gate:
- Current `DeployIntent` status (pending/in_progress/succeeded/failed/cancelled), target SHA
  linked to `github.com/{owner}/{repo}/commit/{sha}`, who approved it and when.
- One-click "Approve deploy of `latestSha`" pre-filled from Check Now's result, plus a raw-SHA
  fallback input for approving something other than the newest commit — reuse this file's own
  existing `MaskedInputLocal`/`TextInputLocal`/`Field` helpers, not new ones.
- "Deploy History" list off `deploy_runs` — same visual language as the existing status block.
- Secret generate/rotate control, reusing `ApiKeysSection.tsx`'s show-once amber-box pattern.

**`MaintenanceBanner.tsx`** — minimal: when the fetched window carries `deployIntentId`, swap in
"an update" copy for the advance-notice/countdown text (new keys, falling back to today's copy);
leave the post-restart confirmation state as a generic "restarted," per §4.

New i18n keys under `admin.integrations.github.deploy.*`, all 7 locale files, verified with
`python3 scripts/check-i18n-parity.py`.

### 6. The agent program

New top-level directory `deploy-agent/` (sibling to `src/`), **excluded from the app's own Docker
build context** (add to `.dockerignore`) since the `Dockerfile`'s production stage only ever
`COPY`s `dist`/`node_modules`/`package.json`/`drizzle`/`src/client/dist`/`public` — a top-level
directory here is never circularly included, but excluding it explicitly keeps `docker build .`
fast regardless.

**Standalone Node.js/TypeScript program**, its own tiny `package.json` + `tsconfig.json`, zero
runtime dependencies beyond Node's own `fetch`/`child_process` — not bundled with, not built by,
the main app's `npm run build`. (A pure-shell alternative was considered and rejected as the
default: it would still need `curl`+`jq` as its own dependencies, so "dependency-free" is mostly
illusory, and Node keeps the JSON contract with the app in the same language everywhere else in
this stack is written in.)

Config via env vars, read once at startup, fail fast if missing:
```
IMPACTIQ_APP_URL, IMPACTIQ_DEPLOY_AGENT_SECRET, DEPLOY_REPO_PATH, DEPLOY_COMPOSE_FILE,
DEPLOY_HEALTH_URL, DEPLOY_POLL_INTERVAL_MS, DEPLOY_HEALTH_TIMEOUT_MS, DEPLOY_ALERT_WEBHOOK_URL (optional)
```

**Poll loop, each tick:**
1. `GET /api/deploy-agent/intent` with the secret header. Network/auth failure → log locally, back
   off, retry — no alert on a transient blip.
2. Nothing pending → no-op, debug-log only (matches the app's own "only log real work" convention).
3. A due, pending intent:
   - `POST /claim`; a `409` (already claimed elsewhere) aborts this tick silently.
   - Idempotency check: if the local repo's `HEAD` already equals `targetSha` *and* the running
     container already passes its health check, skip straight to reporting success rather than
     rebuilding — safe even if polled aggressively or triggered twice.
   - `git fetch` then `git checkout <exact targetSha>` — **never a branch name**, even though
     approval already pinned an exact SHA, so a `main` that moved again between approval and this
     poll still deploys precisely what was approved, not whatever HEAD is by now.
   - `docker compose build` → `docker compose up -d`.
   - Health-check loop against `DEPLOY_HEALTH_URL` (the existing `GET /health` route, which
     already returns `{ data: { status: 'ok', ... } }`) with backoff, up to
     `DEPLOY_HEALTH_TIMEOUT_MS`.
   - **Success** → `POST /report { status: 'ok', ... }`.
   - **Failure (per the user's decision: alert-only, no auto-rollback)** → `POST /report {
     status: 'error', ... }` with retries; if even that fails (the app itself is down), fall
     through to the agent's own independent alert path below — this is the one case that can't
     rely on the app being reachable at all.

**Host access, scoped narrowly** — plan supports both shapes, host choice deferred to rollout:
- *Bare host/VM*: a systemd unit running the agent as a dedicated, narrowly-scoped OS user (in the
  `docker` group, write access only to its own repo checkout and log directory — not a
  general-purpose account), `Restart=on-failure` for free crash resilience.
- *Docker sidecar*: its own minimal container with `/var/run/docker.sock` bind-mounted in — the
  one place in the whole system that legitimately needs it, since "build/swap containers" is
  this component's entire job — plus the host repo checkout bind-mounted as a volume.

Either way: outbound-only (polls the app and GitHub; **never accepts an inbound connection**, so
nothing — not the app, not an internet attacker — can reach it to make it act sooner than its own
clock decides to).

**Independent alerting (both layers always on):** a local structured log file (`journalctl` covers
this for free under systemd) as the last-resort fallback, plus an optional webhook
(`DEPLOY_ALERT_WEBHOOK_URL`, configured in the agent's own env — outside the app's DB entirely, so
it still works when the app/DB is what's unreachable) fired on health-check timeout, git/docker
command failure, or failure to even reach `POST /report` after retries.

### 7. New `AuditAction` entries

Add to `src/shared/auditActions.ts` alongside the existing `system_update.*` block:
`deploy_approve`, `deploy_cancel`, `deploy_report` (via `logSystemAudit`, no Request — same
pattern as `restart_triggered`), `deploy_agent_secret_generate`. Not added to
`DESTRUCTIVE_AUDIT_ACTIONS` — generating/rotating this credential doesn't delete data or revoke
another actor's access the way that list's existing entries do.

---

## Explicitly out of scope for v1

- No cryptographic commit/image signing — trust boundary is "the default admin approved this
  exact, already-pushed SHA through an authenticated session," matching Phase 1's PAT-based trust
  level.
- No multi-host/fleet orchestration or blue-green cutover — matches this app's current
  single-process, single-Postgres deployment shape.
- No auto-rollback (per the user's decision above) — a failed deploy alerts a human, who rolls
  back by hand the same way a manual deploy failure would be handled today.
- No UI-driven agent configuration — the agent's own env vars are host-side files the app can
  never see or edit, by design (the app must never be able to reconfigure its own deploy agent).
- Whether DB migrations need an explicit gating step before the health check is treated as
  "ready" is **not resolved by this plan** — needs a dedicated read of the app's own boot-time
  migration runner (`db/index.ts`'s `runMigrations()`) before Phase 3c is implemented, to confirm
  a passing health check can't happen before migrations that block real functionality complete.

---

## Phased build order

- **3a — App-side plumbing, no agent yet**: `deployIntent.ts`, `deployAgentSecret.ts`, `deploy_runs`
  migration, new `AuditAction`s, the four admin-facing routes, the "Deploy" section + secret UI on
  `GithubUpdatesForm.tsx`, i18n. Fully reviewable and mergeable with zero operational risk — an
  admin can approve intents and generate the secret, but nothing consumes either yet.
- **3b — Agent-facing app routes**: `requireDeployAgentSecret`, the new `deployAgent.ts` router
  (`GET /intent`, `POST /claim`, `POST /report`), its rate limiter, `deploy_report` auditing.
  Testable end-to-end with `curl` before any agent binary exists — a natural checkpoint to review
  the wire contract before building against it.
- **3c — The agent program**: `deploy-agent/` directory, poll loop, git/docker orchestration,
  health-check-with-backoff, local logging, both systemd-unit and sidecar-container packaging
  recipes documented. Test against a disposable/staging host first — this is the one component
  with real host-level power.
- **3d — Linkage + banner polish**: `MaintenanceWindow.deployIntentId`, the combined
  approve-with-scheduled-window admin flow, `MaintenanceBanner.tsx` copy differentiation, a
  deploy-status indicator surfaced separately from the restart-completed banner.

(No 3e — auto-rollback was explicitly declined.)

---

## Critical files

- `src/server/services/updates/maintenanceWindow.ts` — the exact pattern `deployIntent.ts` mirrors
- `src/server/services/updates/restartScheduler.ts` — self-exit behavior (unchanged, see §4) and
  the `logSystemAudit`/`writeRun` call shape `deploy_report` reuses
- `src/server/services/auth/apiKeys.ts` — crypto pattern to reuse (not the table) for the new secret
- `src/server/routes/admin.ts` — where every new admin-facing route lands
- `src/client/components/admin/GithubUpdatesForm.tsx` — where the new Deploy section lands
- `src/client/components/settings/ApiKeysSection.tsx` — show-once secret UI pattern to reuse
- `drizzle/schema.ts` — `systemSettings`/`apiKeys`/`jobRuns`/`auditEvents` conventions this builds on
- `src/shared/auditActions.ts` — where the new `system_update.deploy_*` actions get added
- `src/server/index.ts` — `/api/mcp` mount-point sibling pattern for `/api/deploy-agent`, and the
  existing `/health` route's response shape the agent's own health-check polls against
- `docker-compose.yml` / `Dockerfile` — confirms `deploy-agent/` stays outside the app's build

## Verification (once implemented)

- **3a/3b**: `npx tsc -p tsconfig.server.json --noEmit` and (client) `npx tsc -p tsconfig.json
  --noEmit`; `npx vitest run`; `python3 scripts/check-i18n-parity.py`; manual `curl` against a
  running dev server exercising `POST /admin/updates/deploy-intent` → `GET /api/deploy-agent/intent`
  (with the generated secret header) → `POST /api/deploy-agent/claim` → `POST .../report`,
  confirming `deploy_runs` and the Audit Log both reflect it.
- **3c**: run the agent against a disposable/staging host with a deliberately trivial target
  commit first (e.g. a no-op change), confirming the full loop — checkout, build, up, health-check,
  report — before ever pointing it at anything production-adjacent. Deliberately break a health
  check once (e.g. point `DEPLOY_HEALTH_URL` at a closed port) to confirm the alert-only failure
  path actually fires end-to-end, including the fallback local log when `POST /report` itself is
  made unreachable.
