import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { InfoPopover } from './info-popover.js'

// Shared "what Markdown does this field support" cheat sheet — one info
// icon, reused everywhere a note/description field renders Markdown (the
// Log Activity drawer's Notes tab, My Notes' composer, the activity card's
// standalone Notes drawer). Deliberately short: the 8 things someone
// actually reaches for in a note, not the full CommonMark spec. Each
// "renders as" cell runs through the exact same ReactMarkdown + remarkGfm
// pipeline the saved note itself uses (see markdown-prose.tsx / NotesDrawer's
// NoteCard), so what's shown here is never out of sync with what actually
// happens on save.
const ROWS: Array<{ syntax: string }> = [
  { syntax: '**bold**' },
  { syntax: '_italic_' },
  { syntax: '# Heading' },
  { syntax: '- item' },
  { syntax: '1. item' },
  { syntax: '[text](url)' },
  { syntax: '`code`' },
  { syntax: '> quote' },
]

export function MarkdownHelpPopover() {
  const { t } = useTranslation()
  return (
    <InfoPopover ariaLabel={t('markdown_help.aria_label', 'Markdown formatting help')} widthPx={280}>
      <p className="mb-2 font-semibold text-gray-800 dark:text-gray-100">{t('markdown_help.title', 'Markdown formatting')}</p>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase text-gray-400 dark:text-gray-500">
            <th className="pb-1 font-medium">{t('markdown_help.col_type', 'Type this')}</th>
            <th className="pb-1 font-medium">{t('markdown_help.col_result', 'Get this')}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(({ syntax }) => (
            <tr key={syntax} className="border-t border-gray-100 dark:border-gray-800">
              <td className="py-1 pr-2 align-middle font-mono text-[11px] text-gray-600 dark:text-gray-300">{syntax}</td>
              <td className="py-1 align-middle">
                <div className="md-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{syntax}</ReactMarkdown>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400">
        {t('markdown_help.line_break_tip', 'Press Enter once for a line break — no blank line needed between paragraphs.')}
      </p>
    </InfoPopover>
  )
}
