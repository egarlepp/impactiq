# AI Assistant: the Webhook provider

The Webhook provider (Admin → Integrations → AI Assistant → Add provider → Webhook) sends each AI request to a URL you
control instead of to a model vendor. Whatever answers that URL is "the model": an n8n workflow, an AI gateway (LiteLLM,
Portkey, Kong), or a self-hosted model behind a small adapter. Use it when meeting and note text must stay on your own
network, or when you want your own logic (PII redaction, extra context, model fallback, logging) between ImpactIQ and
the model.

Everything else about the AI Assistant still applies: the master switch, per-feature routing, the monthly budget and the
usage log. The Setup wizard does not offer this provider, because the wizard runs before anyone signs in.

## Settings

| Field | Notes |
|---|---|
| Webhook URL | `https://` and a public address. Tick **The webhook runs on our private network** to allow a private address (10.x, 172.16–31.x, 192.168.x, IPv6 ULA); plain `http://` is then accepted for a private address only. Loopback and link-local (cloud metadata) addresses are always refused. Checked when saved and before every call. Redirects are never followed. |
| Model label | Sent as `model`. ImpactIQ doesn't interpret it; use it to tell your workflow which model to call. Also shown in the usage log and used for the built-in price table (set your own prices to count spend against the budget). |
| Shared secret | Optional. When set, it is sent as `Authorization: Bearer <secret>` and used to sign the request (below). Stored encrypted, never shown again. |

## Request

One `POST` per AI call, `Content-Type: application/json`, `User-Agent: ImpactIQ-Webhook/1`, two-minute timeout.

```json
{
  "version": 1,
  "requestId": "6c1f7a52-0a43-4c2e-9e43-3f1f4c5b2f0e",
  "feature": "activity_classify",
  "model": "default",
  "system": "You classify calendar events for a Sales Engineering team into one of these activity types: ...",
  "user": "Event subject: Acme architecture review",
  "maxTokens": 2000,
  "effort": "low",
  "responseFormat": {
    "type": "json_schema",
    "name": "activity_classification",
    "schema": { "type": "object", "properties": { "activityType": { "anyOf": [{ "type": "string" }, { "type": "null" }] }, "confidence": { "type": "number" } }, "required": ["activityType", "confidence"], "additionalProperties": false }
  }
}
```

- `feature` is one of `activity_classify`, `note_organize`, `note_link_suggest`, `notes_chat`, or `connection_test` (the
  admin page's Test button, which asks for the word OK).
- `system` may be `null`. `effort` is `low`, `medium` or `high`; pass it on or ignore it.
- `responseFormat` is `{ "type": "text" }`, or `json_schema` with the JSON Schema the answer must match. Today
  `activity_classify` and `note_link_suggest` ask for JSON; `note_organize` and `notes_chat` ask for text.
- `version` changes only if the contract changes in a way that breaks existing endpoints.

### Signature

With a shared secret, two more headers are sent:

- `X-ImpactIQ-Timestamp`: Unix seconds.
- `X-ImpactIQ-Signature`: `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw request body>`, keyed with the secret.

Recompute it over the raw body, compare in constant time, and refuse a timestamp more than five minutes old. Checking the
bearer token alone is fine for a webhook only reachable on your network; the signature also protects against a proxy that
logs or replays requests.

```js
const crypto = require('node:crypto')
function verify(secret, timestamp, rawBody, signature) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(signature)
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300
}
```

## Response

`200` with a JSON object, at most 1 MB:

```json
{ "text": "{\"activityType\":\"Discovery\",\"confidence\":0.82}", "usage": { "inputTokens": 412, "outputTokens": 18 } }
```

- `text`: the answer. For a `json_schema` request it is the JSON as a string; you may send it as an object in `json`
  instead (`{ "json": { "activityType": "Discovery", "confidence": 0.82 } }`).
- `usage`: optional. Without it the request is logged with zero tokens and costs nothing against the budget.
- To decline: `{ "refused": true, "message": "Why" }`. The feature falls back to its no-AI behavior, as it does for any
  error.
- `401`/`403` is reported as rejected credentials; any other non-2xx status, a redirect, a timeout or an answer that
  isn't a JSON object is logged as an error and the feature falls back.

## n8n recipe

1. **Webhook** node: method `POST`, Authentication **Header Auth** with name `Authorization` and value
   `Bearer <shared secret>`, Respond **Using 'Respond to Webhook' node**. Copy its Production URL into ImpactIQ.
2. Optional **Switch** on `{{$json.body.feature}}` to treat features differently (for example, redact names before
   `notes_chat`).
3. An LLM node (Basic LLM Chain with the chat model you use: Ollama, OpenAI, Azure OpenAI, Anthropic...). System message
   `{{$json.body.system}}`, prompt `{{$json.body.user}}`. For JSON features, ask for JSON only and include
   `{{JSON.stringify($json.body.responseFormat.schema)}}` in the instructions.
4. **Respond to Webhook**: respond with JSON `{ "text": {{ JSON.stringify($json.text) }} }`, adding `usage` if your
   model node reports it.
5. On ImpactIQ's AI Assistant page, add the Webhook provider, press **Test**, then make it the default or route single
   features to it.
