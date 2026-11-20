# Event webhooks

Admin → Integrations → Event Webhooks (App Admin only) sends a signed JSON `POST` to a URL you choose when something
happens in ImpactIQ. Point it at n8n, Power Automate, Zapier, a Teams or Slack channel (through one of those tools), or
your own service. This is the outbound counterpart of the AI Assistant's Webhook provider (`docs/ai-webhook.md`); both
sign requests the same way.

Delivery is asynchronous: the action that raised the event (submitting an activity, a sync failing) never waits for or
fails because of a webhook. Events are queued in `event_webhook_deliveries` and sent by the `event_webhook_worker` job
(every 30 seconds, Admin → Scheduling).

## Events

| Type | When | `data` |
|---|---|---|
| `activity.submitted` | An activity becomes submitted: created submitted (form, Approve, Approve with template) or a draft edited to submitted. CSV imports and the MCP server do not raise it. | activity, user, team, crm, outlook |
| `activity.crm_sync_failed` | A Salesforce or HubSpot write-back fails for good (it won't retry on its own). | same as above |
| `activity.outlook_deleted` | The Outlook meeting behind an approved activity was deleted, so it waits in the owner's Keep / Delete queue. | same as above |
| `nudge.sent` | A nudge rule fires for a contributor (once per rule, user and day, the same moment the bell gets it). | nudge, user, team |
| `job.failed` | A scheduled job ends with an error. | job |
| `auth.suspicious_sign_in` | A sign-in from an IP address not seen for that person in the last 90 days (the same check as the "new sign-in" email; a first sign-in ever counts, marked `firstSignIn: true`). | user, signIn (method, ip, userAgent, at, firstSignIn) |
| `user.disabled` | An App Admin disables an account (User Management). Not sent again for an account that was already disabled. | user, disabledBy, sessionsRevoked, apiKeysRevoked, at |
| `ai.budget_reached` | AI requests reach the month's budget (Admin → AI Assistant); once a month, with the App Admin email. | ai (month, budgetUsd, spentUsd) |
| `anomaly.found` | The leader dashboards' "What changed" panel finds something in a team's last completed week. Checked every 6 hours by the `anomaly_webhook_scan` job (Admin → Scheduling), only while a webhook subscribes; one event per team per week, none when nothing was found. | team, week (start, end, baselineWeeks), anomalies (code, severity, subject, params, message), notShown |
| `webhook.test` | Only from the admin page's **Send test** button. | webhook, requestedBy |

Each webhook picks its events and, optionally, teams and people. No team ticked means every team; no person added
means everyone. The two filters both apply.

- `job.failed` and `ai.budget_reached` belong to no team, so they ignore the team filter.
- An event about a person (`activity.*`, `nudge.sent`, `auth.suspicious_sign_in`, `user.disabled`) matches the team
  filter when any team that person is on is ticked (an activity or nudge uses its own team), and the person filter when
  the person is on the list.
- Events that aren't about one person (`job.failed`, `ai.budget_reached`, `anomaly.found`) ignore the person filter.
  `anomaly.found` is a team digest; a finding about one contributor names them in `subject`.

An anomaly's `message` is English text matching the panel; `code` and `params` are there to word it yourself. The
(team, week) pairs already checked are kept in `event_webhook_anomaly_scans`.

## Request

```
POST <your URL>
Content-Type: application/json
User-Agent: ImpactIQ-Webhook/1
Authorization: Bearer <secret>
X-ImpactIQ-Event: activity.submitted
X-ImpactIQ-Event-Id: 2f0c8f3e-...
X-ImpactIQ-Delivery: 9b1d...
X-ImpactIQ-Timestamp: 1792800000
X-ImpactIQ-Signature: sha256=<hex>
```

```json
{
  "id": "2f0c8f3e-6c4b-4f0e-9a51-1d2f6c1f7a52",
  "type": "activity.submitted",
  "version": 1,
  "createdAt": "2026-10-23T18:04:11.512Z",
  "data": {
    "activity": {
      "id": "…", "title": "Acme architecture review", "isPrivateMeeting": false, "status": "submitted",
      "type": { "id": "…", "name": "Discovery" }, "subtype": null,
      "start": "2026-10-23T15:00:00.000Z", "end": "2026-10-23T16:00:00.000Z", "effortHours": 1,
      "submittedAt": "2026-10-23T18:04:11.000Z",
      "url": "https://impactiq.example.com/?openActivityId=…&startDate=2026-10-23"
    },
    "user": { "id": "…", "email": "dana@example.com", "displayName": "Dana" },
    "team": { "id": "…", "name": "Sales Engineering" },
    "crm": { "whatType": "Opportunity", "whatId": "006…", "whatName": "Acme renewal", "accountId": "001…",
             "accountName": "Acme", "recordId": null, "syncStatus": "pending", "syncError": null, "syncAttempts": 0 },
    "outlook": { "deletedAt": null }
  }
}
```

- `id` is the event id. If one event goes to two webhooks, both get the same `id`; a retry of the same delivery also
  repeats it, so use it to ignore duplicates.
- A **private meeting's title is never sent** (`title: null`, `isPrivateMeeting: true`), the same rule as everywhere else
  in the app (CLAUDE.md §7). Notes are never sent.
- `url` is null until the app's public URL is known (`APP_URL`).
- `version` changes only if the payload changes in a way that breaks receivers. New fields can appear at any time.

### Signature

Every webhook has a signing secret (`whsec_…`), shown once when the webhook is created or a new secret is made. Check
`X-ImpactIQ-Signature`: `sha256=` + hex HMAC-SHA256 of `<X-ImpactIQ-Timestamp>.<raw body>`, keyed with the secret.
Compare in constant time and refuse a timestamp more than five minutes old. The verification snippet in
`docs/ai-webhook.md` works unchanged. A receiver that can't compute an HMAC (an n8n Header Auth credential, for
example) can check the bearer token instead.

## Answer and retries

Any `2xx` within 15 seconds counts as delivered; the body is ignored. Anything else (another status, a redirect, a
timeout, a refused address) is retried after 1, 5, 15 and 60 minutes, then 3, 6 and 12 hours. After the eighth try,
about 22 hours after the event, the delivery is marked failed. **Retry** on a log row, or **Retry failed** on a webhook
(last 7 days), queues it again from a fresh schedule.

Turning a webhook off drops its waiting deliveries, so it doesn't get a burst of old events when turned back on.
Finished deliveries are deleted after `EVENT_WEBHOOK_DELIVERIES_RETENTION_DAYS` (30 by default) in the housekeeping
sweep.

## Addresses

The URL must be `https://` and resolve to a public address. Tick **The receiver runs on our private network** to allow a
private address (10.x, 172.16–31.x, 192.168.x, IPv6 ULA), where plain `http://` is also accepted. Loopback and
link-local (cloud metadata) addresses are always refused. The address is checked when saved and before every send, so a
DNS change can't move a webhook somewhere it wasn't allowed. Redirects are never followed.

## n8n recipe: post submitted Discovery activities to a Teams channel

1. **Webhook** node: method `POST`, Authentication **Header Auth** (`Authorization` = `Bearer <secret>`), Respond
   **Immediately**. Copy its Production URL into a new ImpactIQ webhook subscribed to `activity.submitted`.
2. **If** node: `{{$json.body.data.activity.type.name}}` equals `Discovery`.
3. **Microsoft Teams** node (Send message to channel), text:
   `{{$json.body.data.user.displayName}} logged a Discovery for {{$json.body.data.crm.accountName}}: {{$json.body.data.activity.url}}`.
4. Back in ImpactIQ press **Send test**, then submit a real activity and watch the delivery log.

The same shape works for `nudge.sent` (send the nudge message to the person in Teams) or `job.failed` (open a ticket).
