# ImpactIQ MCP Server

ImpactIQ ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets LLM agents — Claude Desktop, Claude Code, Cursor, n8n's MCP Client Tool node, and any other MCP-aware client — query the app's data in a structured way. Ask "what's my team's ACV this week?" or "list every activity for Acme Corp in the last month" and the model calls the appropriate MCP tool, gets a JSON payload, and turns it into an answer.

**v1 posture: read-only.** Every tool queries. None mutate. Write tools (create activity, add note, override SF suggestion) ship in a later release once the audit-log gap is closed.

## Endpoint

```
POST/GET https://<your-impactiq-host>/api/mcp
```

Transport: **Streamable HTTP** — a single endpoint that supports both the JSON-RPC POST request/response and the SSE upgrade for server-initiated messages. Stateless (no session cookie); every request authenticates via `Authorization: Bearer <token>`.

## Authentication

Personal API keys with the **`mcp:read`** scope. *(v1.288+)* Self-issuing an `mcp:read` key requires the caller to hold a leader/admin/team_admin role on at least one team, or be an App Admin — a plain Contributor can still mint a `rest:full` key for their own use, but not `mcp:read`, since MCP tools surface cross-user data within the caller's teams (§ below), which is broader than a Contributor's own session permissions.

1. In ImpactIQ, open **My Settings → API Keys**.
2. Click **New**.
3. Name it something recognizable (`Claude Desktop`, `n8n MCP tool`, …).
4. **Uncheck `rest:full`** and **check `mcp:read`**. The token will be MCP-only and cannot call REST endpoints if leaked.
5. Set an expiry (recommended: 90 days).
6. Copy the `iqk_…` token that's shown ONCE. Paste it into your MCP client.

The Admin can revoke any token from **Admin → Monitoring → MCP Activity** or turn the entire MCP server off tenant-wide from **Admin → Integrations → MCP Server**.

## Configuration snippets

**Which client should I use?** ImpactIQ's MCP server authenticates every call via a static
`Authorization: Bearer <mcp:read token>` header — there's no OAuth flow (see Roadmap below). That
means the client you pick has to support supplying a custom header, which not every Claude surface
does yet:

| Client | Accepts a custom Bearer header? | Setup |
|---|---|---|
| Claude Desktop | Yes — `mcp.json` | See below |
| Claude Code CLI | Yes — `claude mcp add --header` | See below |
| Cowork | Yes — connector settings | See below |
| n8n MCP Client Tool node | Yes — node's Headers field | See below |
| **claude.ai web (Connectors)** | **Not today** — the "Add custom connector" dialog only takes a Name and a Remote MCP server URL, no header field | See below for what to try, and the fallback |

If your team's primary Claude surface is the web app, read the **claude.ai (Web) — Connectors**
section first — it explains exactly what does and doesn't work there today, and which of the
other clients to fall back to in the meantime.

### claude.ai (Web) — Connectors

1. Go to **claude.ai → Settings → Connectors → Add custom connector**.
2. **Name**: anything recognizable (e.g. `ImpactIQ`).
3. **Remote MCP server URL**: `https://<your-impactiq-host>/api/mcp`.
4. Click **Continue**.

That's the entire dialog — there is no field here for an `Authorization` header or API key. If
Claude's next step prompts you to authenticate against the server, an `mcp:read` token may work
there; if it doesn't (most likely today, since ImpactIQ's server expects a static Bearer token
rather than an OAuth handshake), the connector will fail to reach any tool that needs auth. This is
a real, current limitation of connecting a Bearer-token-only MCP server through the web Connectors
UI — not a mistake in the URL or key.

**Until that's resolved, use one of the clients below instead** — Claude Desktop, Claude Code CLI,
and Cowork all let you supply the `Authorization` header directly, so they work today. My Settings
→ API Keys in the app itself shows the same guidance (and a ready-to-paste `mcp.json` snippet with
your actual key filled in) right where you create an `mcp:read` key.

### Claude Desktop (`~/Library/Application Support/Claude/mcp.json`)

```json
{
  "mcpServers": {
    "impactiq": {
      "transport": "http",
      "url": "https://impactiq.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer iqk_YOUR_MCP_READ_TOKEN"
      }
    }
  }
}
```

Restart Claude Desktop — ImpactIQ tools show up in the tool picker.

### n8n MCP Client Tool node

1. In your workflow, add the **MCP Client Tool** node (n8n 1.90+).
2. Server URL: `https://impactiq.example.com/api/mcp`
3. Headers: `Authorization: Bearer iqk_YOUR_MCP_READ_TOKEN`
4. Enable the tools you want to expose to the downstream LLM node (OpenAI, Anthropic, etc.). The LLM node references the MCP Client Tool as a tool source.

### Claude Code CLI

```bash
claude mcp add --url https://impactiq.example.com/api/mcp \
  --header "Authorization: Bearer iqk_YOUR_MCP_READ_TOKEN" \
  impactiq
```

### Cowork

Add ImpactIQ as an MCP connector in Cowork's settings using the same URL + Bearer header.

## Tools

All tools return `{ content: [{ type: 'text', text: '<JSON string>' }] }`. The JSON in the `text` field carries the payload described below.

### `dashboards.manager_rollup`
Cross-team KPI rollup (hours, cost, ACV, activities, unique contributors, unique Opps) for every team the calling user can see.

- Input: `{ weeks: 1–52 (default 8) }`
- Output: array of `{ teamId, teamName, hours, activities, uniqueContributors, uniqueOpps }` sorted by hours desc.

### `activities.list`
List submitted activities across the calling user's accessible teams. `teamId`, if given, must be one of those teams — anything else returns an empty result rather than erroring, so a bad guess doesn't accidentally read another team's data.

- Input: `{ userId?, teamId?, from?, to?, limit: 1–200 (default 50) }`
- Output: array of `{ id, title, userId, teamId, startDatetime, effortHours, crmWhatType, crmWhatName, crmAccountName, salesStage, acv }`.

### `activities.get`
Fetch a single activity by id. Only returns the row when it belongs to one of the caller's accessible teams — an out-of-scope id is reported the same as a nonexistent one, so this can't be used to probe for other teams' activity ids.

- Input: `{ id: uuid }`
- Output: full activity row including description body, CRM snapshot fields, and audit metadata.

*(v1.411+)* The CRM fields in `activities.list` and `activities.get` output are named `crm*` (`crmWhatId`, `crmWhatType`, `crmAccountName`, `crmSyncStatus`, ...). Before v1.411 they were `sf*` (`sfWhatId`, ...). Agent prompts or n8n flows that read the old names need updating.

### `users.list`
Users who share at least one team with the calling user. Useful for resolving a display name to an `id` before calling `activities.list`.

- Input: `{}` (no args)
- Output: array of `{ id, email, displayName, defaultTeamId }`.

### `teams.list`
Teams the calling user has access to. Useful for resolving a team name to an `id`.

- Input: `{}` (no args)
- Output: array of `{ id, name, slug, isActive }`.

### CRM tools *(v1.402+)*

These run on whichever CRM the install uses (Salesforce or HubSpot, set in Admin → Integrations → CRM), always as the **calling user**: on Salesforce through their own connection (never the admin connection), on HubSpot through the portal connection with "my records" meaning the HubSpot owner matched to the user's email. Each returns `{ crm, data, count?, error? }`, where `crm` is `salesforce`, `hubspot` or `null`. Records keep ImpactIQ's field names on both CRMs (a HubSpot Deal comes back as an Opportunity, a Company as an Account).

Errors come back in `error` rather than as a failed call:

| `error` | Meaning |
|---|---|
| `crm_not_configured` | The install has no active CRM. |
| `crm_not_connected` | Salesforce: the caller hasn't connected their own account. HubSpot: the portal connection is missing. |
| `invalid_record_id` | `crm.get_record` was given an id that isn't shaped like this CRM's record id. Nothing is sent to the CRM. |
| `not_found` | `crm.get_record` found no record. |
| anything else | The CRM's own error (an `errors.hubspot.*` key, or the Salesforce message). |

#### `crm.search_opportunities`
Opportunities (Deals on HubSpot) the caller works on: on Salesforce the Assigned SE / Primary Engineer / Specialist Engineer / Supporting Engineer filter, on HubSpot the Deals they own or are the mapped SE on, the same default the in-app search uses. Open records only unless `includeClosed`. Team-scoped field mappings come from the caller's default team.

- Input: `{ q: string (2–120 chars), limit: 1–50 (default 20), includeClosed: boolean (default false) }`
- Output `data`: array of `{ Id, Name, StageName, AccountId, AccountName, CloseDate, Amount, ForecastCategoryName, OwnerName }`.

#### `crm.search_accounts`
Accounts (Companies on HubSpot) by name, as the in-app Account tab searches them.

- Input: `{ q: string (2–120 chars), limit: 1–50 (default 20) }`
- Output `data`: array of Account rows (`Id`, `Name`, plus the location fields the CRM returns).

#### `crm.get_record`
The live state of one Opportunity/Deal or Account/Company, the same read the hover preview makes (stage, forecast, amount, close date, owner, Assigned SE for an Opportunity; owner, industry, type, location, website for an Account).

- Input: `{ type: 'Opportunity' | 'Account', id: string (1–40 chars) }`
- Output `data`: the preview object.

#### `salesforce.search_opportunities` (deprecated)
An alias of `crm.search_opportunities`, kept so existing agent setups keep working; it runs on HubSpot too. Before v1.402 it ran on Salesforce only and its errors were `sf_not_connected` and `crm_provider_mismatch`; it now returns the `{ crm, data, count, error }` shape above with the error codes in the table. Use `crm.search_opportunities` in new setups.

## Rate limiting

| Limit | Default | Env override |
|-------|---------|--------------|
| Per token per minute | 60 | `MCP_RATE_PER_MIN` |
| Per token per hour | 1000 | `MCP_RATE_PER_HOUR` |
| Per tenant per day | 5000 | `MCP_RATE_TENANT_DAILY` |

429s carry a `Retry-After` header. The rate limiter is in-memory + single-process — matches every other limiter in the app today. Multi-instance deploys should move to Redis before opening MCP to many concurrent agents.

## Audit

Every MCP call writes one row to `mcp_tool_calls`:

- `tool` — MCP tool name.
- `args_hash` — SHA-256 (first 32 hex chars) of the JSON args. Not the args themselves — no PII persisted.
- `status` — `ok` / `error` / `throttled`.
- `latency_ms`.
- `error` — server-side error message on failure.
- `api_key_id`, `user_id` — who called.

Retention: 30 days, culled by the existing `syncAuditCull` worker (matches sync-audit + nudge-history). Surfaced at **Admin → Monitoring → MCP Activity**.

## Kill switch

An App Admin can turn the whole MCP server off tenant-wide from **Admin → Integrations → MCP Server** → *Turn off*. Every subsequent MCP call returns `503 mcp_disabled_by_admin` until it's turned back on. Existing tokens keep working when the flag flips back on — no re-issuance required.

## Roadmap

### v2 — writes

Adds the `mcp:write` scope and a curated set of mutating tools. Gated on
two prerequisites landing first, since neither exists today:

- **Expand the audit-log enum** (`src/server/services/audit/log.ts`) to
  cover activity and note mutations — right now `logAudit` only tracks
  admin/config writes (`user.*`, `team.*`, `integration.*`, …). Without
  this, an LLM-created activity is invisible to the Audit Log page.
- **Add a `via` column to `audit_events`** (`session | apikey | mcp`) so
  admins can filter "what did the LLM change" separately from normal
  user edits. Needed before any write tool ships, not optional polish.

Planned v2 write tools, in rough priority order:
1. `activities.create` — draft only, never auto-submits. Requires
   `activityTypeId`, `title`, `startDatetime`, `endDatetime`,
   `effortHours`; optional SF linkage fields. Returns the created row's
   `id` so a follow-up call can review before submit.
2. `activities.submit` — separate from create so an agent must take two
   explicit steps to push something into a leader's numbers. Enforces
   the same 90-day-edit-window and RBAC checks the REST endpoint does.
3. `notes.create` — attach a note to an activity/opportunity/account.
   Respects the existing private/team visibility rules unchanged.
4. `salesforce.suggestion_override` — accept/override an Outlook →
   SF Account/Opportunity suggestion. Read-adjacent (doesn't touch SF
   directly, only ImpactIQ's cached suggestion), so this may ship
   ahead of the other three if the audit prerequisites land in stages.

Explicitly **not** planned for v2: direct Salesforce writes (`sf.*`
mutation tools), Outlook calendar mutations, or activity `delete` — all
three have higher blast radius than the app's own REST surface allows
today (writeback is queued + retried; delete is already restricted to
90 days). These stay REST-only until there's a specific driving use case.

### v3 — governance & scale

- **Per-tool ACL admin matrix** — a tenant-level on/off toggle per tool
  (not just the current all-or-nothing `mcp_enabled` switch), so e.g. a
  tenant could allow `activities.list` but disable
  the `crm.*` tools if they don't want LLM agents touching CRM data
  even read-only.
- **Redis-backed rate limiter** — today's limiter
  (`src/server/middleware/mcp-rate-limit.ts`) is in-memory and
  single-process, matching every other limiter in the app. Move to
  Redis only when ImpactIQ actually runs multi-instance; premature
  before that.
- **Cowork connector catalog listing** — publish ImpactIQ as a
  one-click MCP connector in an internal Cowork catalog instead
  of requiring manual `mcp.json` / n8n node configuration.
- **Per-key usage quotas configurable from the UI** — today's
  `MCP_RATE_PER_MIN` / `MCP_RATE_PER_HOUR` / `MCP_RATE_TENANT_DAILY`
  are env vars set at deploy time. A v3 admin screen could let App
  Admins tune these per-tenant without a redeploy.
- **Streaming tool results** — today every tool returns a single JSON
  blob. Large `activities.list` result sets could stream incrementally
  once a real use case needs it (none identified yet).

### Deferred indefinitely (no current driver)

- **OAuth-based MCP auth** (replacing Bearer API keys) — MCP's spec
  supports an OAuth flow for dynamic client registration. The
  identity model (Okta + password auth) doesn't have a natural fit for
  this yet, and static API keys are adequate for the current agent
  count. Revisit if third-party MCP clients outside the organization need
  access. **A concrete driver has since emerged**: claude.ai's web
  Connectors UI ("Add custom connector") has no field for a static
  Bearer token — its "Add custom connector" dialog only takes a Name
  and a Remote MCP server URL — so a static-token-only server like
  ImpactIQ's cannot be reached from that surface today (see
  "Configuration snippets" above). This doesn't change the decision by
  itself — Claude Desktop, Claude Code CLI, and Cowork all still work
  fine with Bearer auth — but it's the first real example of the
  "third-party MCP clients... need access" trigger this bullet was
  waiting on, worth weighing next time this list gets revisited.
- **Multi-tenant MCP server sharing** (one MCP endpoint serving several
  ImpactIQ tenants) — not applicable; each ImpactIQ deployment is
  already single-tenant.
