// v1.114.0: shared "send via a named email rule" helper. Every outbound
// email code path calls this so:
//  1. The Active/Inactive toggle on Admin → Email Communications gates
//     dispatch centrally.
//  2. Admin-edited subject/body templates override the hardcoded
//     defaults when set. Nulls fall back to the caller's defaults —
//     admins only need to touch templates they want to customise.
//  3. Token substitution ({{name}}, {{ip}}, …) happens in one place
//     with a simple, predictable replacement so admins can copy tokens
//     verbatim from the editor hint into their template.
//
// Extend TOKEN sets in EmailCommunicationsConfig.tsx if you add new
// callers — the two lists must stay in lockstep.

import { db } from '../../db/index.js'
import { emailRules } from '../../../../drizzle/schema.js'
import { eq } from 'drizzle-orm'
import { sendEmailViaConfigured, type EmailMessage } from './index.js'
import { getEmailIntegrationConfig } from '../config/integrations.js'
import { isEmailRuleActive, type EmailRuleKey } from './rules.js'
import { escapeHtml } from './template.js'
import { emailRuleSupportsSlackDm } from '../../../shared/emailRuleSlack.js'
import { deliverSlackDmToUser, type SlackDmResult } from '../slack/dm.js'

export interface SendByRuleInput {
  to: string
  toName?: string | undefined
  greetingName?: string
  // Fallback subject / body when the admin hasn't customised the rule.
  defaultSubject: string
  defaultBodyHtml: string
  defaultBodyText: string
  // Values available for {{token}} substitution in whichever template
  // (default or admin-customised) is used.
  tokens?: Record<string, string | number | null | undefined>
  // v1.436.0: the recipient's ImpactIQ user id. When the rule has "Also
  // send as Slack DM" on (Admin → Communications), the same subject and
  // plaintext body also go to this user as a Slack DM.
  userId?: string | undefined
  severity?: 'info' | 'warning' | 'critical'
}

export interface SendByRuleResult {
  sent: boolean
  reason?: string
  emailed?: boolean
  slack?: SlackDmResult
}

// Slack attachment text tops out well before an email body does.
const SLACK_TEXT_MAX = 3000

// v1.289.0: security audit finding C1 — token values can originate from
// client-controlled input (e.g. the `userAgent` token below is the raw
// `User-Agent` request header) or user-editable profile fields
// (`displayName`). Substituting them into bodyHtml unescaped was an
// HTML-injection primitive into transactional email. `htmlEscape: true`
// escapes every substituted value except any key listed in `rawHtmlKeys` —
// the one legitimate exception today is `itemsList` (digest.ts), which
// intentionally carries pre-built `<ul><li>…` markup. Subject lines and
// plaintext bodies are never escaped — they aren't HTML, so escaping would
// show literal `&amp;` etc. to the recipient.
function interpolate(
  template: string,
  tokens: Record<string, string | number | null | undefined> | undefined,
  opts: { htmlEscape?: boolean; rawHtmlKeys?: ReadonlySet<string> } = {},
): string {
  if (!tokens) return template
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k: string) => {
    const v = tokens[k]
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (opts.htmlEscape && !opts.rawHtmlKeys?.has(k)) return escapeHtml(s)
    return s
  })
}

// The only token any caller today intentionally fills with pre-built HTML
// markup rather than plain text — see interpolate()'s comment above.
const RAW_HTML_TOKEN_KEYS = new Set(['itemsList'])

async function loadRuleTemplates(key: string): Promise<{ subject: string | null; body: string | null; sendSlack: boolean }> {
  try {
    const [row] = await db
      .select({ subject: emailRules.subjectTemplate, body: emailRules.bodyTemplate, sendSlack: emailRules.sendSlack })
      .from(emailRules)
      .where(eq(emailRules.key, key))
      .limit(1)
    return { subject: row?.subject ?? null, body: row?.body ?? null, sendSlack: row?.sendSlack ?? false }
  } catch {
    return { subject: null, body: null, sendSlack: false }
  }
}

// v1.114.0: naive html-to-text — strips tags, collapses whitespace.
// Used when admin overrides the body HTML but no plaintext version.
// v1.181.1: strip tags to a fixpoint (a single pass leaves `<scr<script>ipt>`
// as `<script>`), and decode `&amp;` LAST so entity decoding can't double-
// unescape (`&amp;lt;` must not become `<`).
export function htmlToText(html: string): string {
  let s = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
  // Remove tags repeatedly until stable so nested/split tags can't survive.
  let prev: string
  do { prev = s; s = s.replace(/<[^>]+>/g, '') } while (s !== prev)
  return s
    .replace(/&nbsp;/g, ' ')
    // Decode named/numeric entities first, then `&amp;` last so a literal
    // `&amp;lt;` decodes to `&lt;` (text), never to `<`.
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
}

export async function sendByRule(key: EmailRuleKey, input: SendByRuleInput): Promise<SendByRuleResult> {
  if (!(await isEmailRuleActive(key))) return { sent: false, reason: 'rule_inactive' }
  const tpl = await loadRuleTemplates(key)
  const subject = interpolate(tpl.subject ?? input.defaultSubject, input.tokens)
  const bodyHtml = interpolate(tpl.body ?? input.defaultBodyHtml, input.tokens, { htmlEscape: true, rawHtmlKeys: RAW_HTML_TOKEN_KEYS })
  const bodyText = tpl.body
    ? htmlToText(bodyHtml)
    : interpolate(input.defaultBodyText, input.tokens)
  const greet = input.greetingName ?? input.toName
  const msg = {
    to: input.to,
    subject,
    category: key,
    html: bodyHtml,
    text: bodyText,
    ...(input.toName ? { toName: input.toName } : {}),
    ...(greet ? { greetingName: greet } : {}),
  } as EmailMessage

  // v1.436.0: the Slack copy goes first and never throws, so an SMTP error
  // can't swallow it and a Slack error can't block the email.
  let slack: SlackDmResult | undefined
  if (tpl.sendSlack && input.userId && emailRuleSupportsSlackDm(key)) {
    slack = await deliverSlackDmToUser(input.userId, {
      heading: subject,
      text: bodyText.length > SLACK_TEXT_MAX ? `${bodyText.slice(0, SLACK_TEXT_MAX - 1)}…` : bodyText,
      severity: input.severity ?? 'info',
    })
  }
  // With no email integration, a delivered DM still counts as sent (a
  // Slack-only install). Otherwise keep the old "Email not configured"
  // error, which callers already handle.
  if (!getEmailIntegrationConfig() && slack?.ok) {
    return { sent: true, emailed: false, slack }
  }
  await sendEmailViaConfigured(msg)
  return { sent: true, emailed: true, ...(slack ? { slack } : {}) }
}
