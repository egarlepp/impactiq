import type { ReactNode } from 'react'

// Turns any http(s) URL or email address found in plain notification/
// announcement text into a real clickable link. Authors write these as
// plain text (there's no rich-text editor for either notifications or
// announcements), so this is the only way a pasted link or contact email
// ever becomes clickable instead of dead text.
const LINK_RX = /(https?:\/\/[^\s<>"']+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g
// A matched URL/email frequently has trailing sentence punctuation the regex
// has no way to know isn't part of the link ("...see https://x.com/y." or a
// link wrapped in parens) — stripped back onto the plain-text tail instead.
const TRAILING_PUNCT_RX = /[.,!?;:'")\]]+$/

export function linkifyText(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  const rx = new RegExp(LINK_RX)
  let match: RegExpExecArray | null
  while ((match = rx.exec(text)) !== null) {
    let matched = match[0]
    const isEmail = match[1] === undefined
    const trailing = matched.match(TRAILING_PUNCT_RX)?.[0] ?? ''
    if (trailing) matched = matched.slice(0, -trailing.length)
    if (!matched) continue
    const start = match.index
    if (start > lastIndex) parts.push(text.slice(lastIndex, start))
    parts.push(
      <a
        key={`lnk-${key++}`}
        href={isEmail ? `mailto:${matched}` : matched}
        target={isEmail ? undefined : '_blank'}
        rel={isEmail ? undefined : 'noopener noreferrer'}
        className="underline decoration-1 underline-offset-2 hover:opacity-80"
        onClick={(e) => e.stopPropagation()}
      >
        {matched}
      </a>,
    )
    lastIndex = start + matched.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length > 0 ? parts : [text]
}
