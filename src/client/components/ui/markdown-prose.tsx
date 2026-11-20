import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { cn } from '../../lib/utils.js'

// v1.255.4: shared "full Markdown, comfortably spaced" renderer for
// Markdown that IS the primary content of a page section (Guide's
// Distinctions, its admin Preview) — as opposed to the base `.md-body`
// class alone, which the Notes panel also uses but tuned tight (2–4px
// margins) for a small dense side panel.
//
// v1.255.5: the extra spacing is the `md-body-spaced` plain-CSS class
// (index.css), NOT Tailwind child-selector utilities. An earlier version
// of this component used `[&_p]:mb-3`-style arbitrary variants, which
// compile into Tailwind's `@layer utilities` — and `.md-body`'s own
// margin rules in index.css are plain, unlayered CSS. Unlayered CSS
// always wins the cascade over anything inside a `@layer` at equal
// specificity, regardless of utility specificity or source order, so
// those utilities never actually overrode `.md-body`'s tighter margins.
// `md-body-spaced` is defined in index.css as `.md-body.md-body-spaced`
// (two classes) specifically so it out-specifies the base `.md-body`
// single-class rules it needs to beat.
//
// remarkGfm (tables, strikethrough, task lists, autolinks) + remarkBreaks
// (a single newline renders as a real line break, matching how a plain
// textarea author expects "Enter" to behave) together with `.md-body`'s
// existing heading/list/blockquote/code/table/hr styles cover the full
// standard Markdown feature set. `skipHtml` is a deliberate security
// default (no raw HTML passthrough) matching NotesDrawer's convention.
export function MarkdownProse({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('md-body md-body-spaced', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml>{children}</ReactMarkdown>
    </div>
  )
}
