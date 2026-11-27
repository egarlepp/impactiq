// Email senders for the daily notification digest.
// Three transports are supported:
//   1. SMTP relay (admin-configured shared mailbox)
//   2. Microsoft Graph App-Only (admin-configured service principal +
//      sendMail as a designated mailbox)
//   3. Microsoft Graph User Delegated (legacy: send from each user's own
//      connected Outlook OAuth token). Retained for callers that still rely
//      on per-user OAuth (e.g. the old "send as me" flow).
//
// The digest cron picks transport based on the admin's Email Configuration.

import { db } from '../../db/index.js'
import { userIntegrations } from '../../../../drizzle/schema.js'
import { and, eq } from 'drizzle-orm'
import { decryptToken } from '../config/crypto.js'
import { getEmailIntegrationConfig } from '../config/integrations.js'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { microsoftLoginUrl } from '../auth/microsoftLogin.js'

export interface InlineImageAttachment {
  contentId: string
  filename: string
  contentType: string
  contentBase64: string
}

export interface EmailMessage {
  to: string
  toName?: string
  subject: string
  html: string
  text: string
  // v1.103.0: inline images referenced from HTML as cid:contentId. Both
  // Graph and SMTP transports embed these as multipart/related inline
  // parts so Outlook (Windows desktop) actually renders them instead
  // of silently dropping data:image/* sources.
  attachments?: InlineImageAttachment[]
  // v1.85.0: opt-in template wrap. When set, the html/text fields are
  // treated as the *body* of the branded template (top/bottom bars from
  // the active theme, "Hello {greetingName}," prefix, ImpactIQ footer).
  // When omitted the message ships raw — used for a small number of legacy
  // callers that already pass a fully-formed HTML doc.
  greetingName?: string
  // v1.440.0: what kind of email this is, for the delivery log (App Health):
  // the email rule key, or 'daily_digest' / 'weekly_recap' / 'test'.
  category?: string
}

// ── Microsoft Graph (user delegated, legacy) ────────────────────────────────

export async function sendViaGraph(userId: string, msg: EmailMessage): Promise<void> {
  const [row] = await db
    .select()
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, 'microsoft')))
    .limit(1)
  if (!row?.accessTokenEncrypted) throw new Error('User has not connected Outlook')
  const accessToken = decryptToken(row.accessTokenEncrypted)

  const graphAttachments = (msg.attachments ?? []).map((a) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename,
    contentType: a.contentType,
    contentId: a.contentId,
    isInline: true,
    contentBytes: a.contentBase64,
  }))
  const body = {
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      toRecipients: [{ emailAddress: { address: msg.to, name: msg.toName } }],
      ...(graphAttachments.length > 0 ? { attachments: graphAttachments } : {}),
    },
    saveToSentItems: 'true',
  }

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Graph sendMail failed (${res.status}): ${text}`)
  }
}

// ── Microsoft Graph App-Only (service principal) ────────────────────────────

let cachedAppToken: { token: string; expiresAt: number } | null = null

async function getAppToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  if (cachedAppToken && cachedAppToken.expiresAt > Date.now() + 60_000) return cachedAppToken.token
  const url = microsoftLoginUrl(tenantId, '/oauth2/v2.0/token')
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })
  const res = await fetch(url, { method: 'POST', body })
  if (!res.ok) {
    throw new Error(`Graph token endpoint failed (${res.status}): ${await res.text()}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  cachedAppToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 }
  return json.access_token
}

async function sendViaGraphApp(msg: EmailMessage): Promise<void> {
  const cfg = getEmailIntegrationConfig()
  if (!cfg || cfg.authMethod !== 'graph_app') throw new Error('Graph App-Only email not configured')
  const token = await getAppToken(cfg.tenantId, cfg.clientId, cfg.clientSecret)
  const graphAttachments = (msg.attachments ?? []).map((a) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: a.filename,
    contentType: a.contentType,
    contentId: a.contentId,
    isInline: true,
    contentBytes: a.contentBase64,
  }))
  const body = {
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      toRecipients: [{ emailAddress: { address: msg.to, name: msg.toName } }],
      ...(cfg.replyToAddress
        ? { replyTo: [{ emailAddress: { address: cfg.replyToAddress } }] }
        : {}),
      ...(graphAttachments.length > 0 ? { attachments: graphAttachments } : {}),
      from: { emailAddress: { address: cfg.fromAddress } },
    },
    saveToSentItems: 'true',
  }
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.senderMailbox)}/sendMail`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`Graph App-Only sendMail failed (${res.status}): ${await res.text()}`)
  }
}

// ── SMTP (minimal, dependency-free) ─────────────────────────────────────────

function buildMime(from: string, replyTo: string | null, msg: EmailMessage): string {
  const altBoundary = `alt_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    msg.text,
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    msg.html,
    '',
    `--${altBoundary}--`,
    '',
  ].join('\r\n')

  const attachments = msg.attachments ?? []
  const headers = [
    `From: ${from}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    'MIME-Version: 1.0',
  ]

  if (attachments.length === 0) {
    return headers.concat([altPart]).join('\r\n')
  }

  // v1.103.0: multipart/related wraps the alternative body + each inline
  // image so Outlook renders <img src="cid:..."> correctly.
  const relBoundary = `rel_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/related; boundary="${relBoundary}"; type="multipart/alternative"`,
    '',
    `--${relBoundary}`,
    altPart,
  ]
  for (const a of attachments) {
    parts.push(
      `--${relBoundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${a.contentId}>`,
      `Content-Disposition: inline; filename="${a.filename}"`,
      '',
      a.contentBase64.match(/.{1,76}/g)?.join('\r\n') ?? a.contentBase64,
      '',
    )
  }
  parts.push(`--${relBoundary}--`, '')
  return parts.join('\r\n')
}

function smtpCommand(socket: net.Socket | tls.TLSSocket, command: string, expectCode: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const linesArr = buf.split(/\r?\n/)
      const last = linesArr[linesArr.length - 2]
      if (!last) return
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData)
        const code = parseInt(last.slice(0, 3), 10)
        if (code !== expectCode) {
          reject(new Error(`SMTP expected ${expectCode}, got ${last}`))
        } else {
          resolve(buf)
        }
      }
    }
    socket.on('data', onData)
    if (command) socket.write(command + '\r\n')
  })
}

async function sendViaSmtpInternal(msg: EmailMessage): Promise<void> {
  const cfg = getEmailIntegrationConfig()
  if (!cfg || cfg.authMethod !== 'smtp') throw new Error('SMTP not configured')

  const socket: net.Socket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port })

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('secureConnect', () => resolve())
      socket.once('error', reject)
    })
    await smtpCommand(socket, '', 220)
    await smtpCommand(socket, `EHLO impactiq`, 250)
    await smtpCommand(socket, 'AUTH LOGIN', 334)
    await smtpCommand(socket, Buffer.from(cfg.username).toString('base64'), 334)
    await smtpCommand(socket, Buffer.from(cfg.password).toString('base64'), 235)
    await smtpCommand(socket, `MAIL FROM:<${cfg.fromAddress}>`, 250)
    await smtpCommand(socket, `RCPT TO:<${msg.to}>`, 250)
    await smtpCommand(socket, 'DATA', 354)
    const mime = buildMime(cfg.fromAddress, cfg.replyToAddress, msg)
    const stuffed = mime.replace(/^\./gm, '..')
    socket.write(stuffed + '\r\n.\r\n')
    await smtpCommand(socket, '', 250)
    await smtpCommand(socket, 'QUIT', 221)
  } finally {
    socket.destroy()
  }
}

// ── Public dispatcher ───────────────────────────────────────────────────────

export async function sendViaSmtp(msg: EmailMessage): Promise<void> {
  // Back-compat shim: the digest worker called sendViaSmtp; route to whichever
  // transport the admin configured.
  await sendEmailViaConfigured(msg)
}

export async function sendEmailViaConfigured(msg: EmailMessage): Promise<void> {
  const cfg = getEmailIntegrationConfig()
  if (!cfg) throw new Error('Email not configured')
  // v1.85.0: every outbound email gets wrapped in the active theme's
  // branded template — top/bottom bars, ImpactIQ mark on the left of the
  // header, tenant logo on the right, footer with generation line. The
  // caller's html/text becomes the middle body area. greetingName falls
  // back to toName or "there" so the "Hello X," line always renders.
  const { renderWithActiveTheme } = await import('./template.js')
  const rendered = await renderWithActiveTheme({
    greetingName: msg.greetingName ?? msg.toName ?? 'there',
    subject: msg.subject,
    bodyHtml: msg.html,
    bodyText: msg.text,
  })
  const outgoing: EmailMessage = { ...msg, html: rendered.html, text: rendered.text, attachments: rendered.attachments }
  const transport = cfg.authMethod === 'graph_app' ? 'graph_app' as const : 'smtp' as const
  const { recordEmailDelivery } = await import('./deliveryLog.js')
  const logged = { category: msg.category ?? 'other', recipient: msg.to, subject: msg.subject, transport }
  try {
    if (transport === 'graph_app') await sendViaGraphApp(outgoing)
    else await sendViaSmtpInternal(outgoing)
  } catch (err) {
    await recordEmailDelivery({ ...logged, error: err })
    throw err
  }
  await recordEmailDelivery({ ...logged, error: null })
}
