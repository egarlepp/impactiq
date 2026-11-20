import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCheck, FileText, ListChecks, Target } from 'lucide-react'
import { AI_NOTE_SECTIONS, type AiNoteSection } from '../../../shared/aiNotes.js'

// Checkbox list of AI Note sections, shared by Admin → Workplace → AI Notes
// (team default) and My Settings → AI Notes (a person's own choice).

export const AI_NOTE_SECTION_ICONS: Record<AiNoteSection, typeof FileText> = {
  summary: FileText,
  checked: CheckCheck,
  next_steps: ListChecks,
  risks: AlertTriangle,
  meddpicc: Target,
}

// v1.461.0: one color per section, so a section is recognizable at a glance
// on the AI Notes tab (header band, icon and left edge) and in the picker.
export const AI_NOTE_SECTION_STYLES: Record<AiNoteSection, { icon: string; header: string; edge: string; count: string }> = {
  summary: {
    icon: 'text-sky-600 dark:text-sky-400',
    header: 'bg-sky-50 hover:bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:hover:bg-sky-950/70 dark:text-sky-100',
    edge: 'border-l-sky-500 dark:border-l-sky-400',
    count: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  },
  checked: {
    icon: 'text-emerald-600 dark:text-emerald-400',
    header: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:hover:bg-emerald-950/70 dark:text-emerald-100',
    edge: 'border-l-emerald-500 dark:border-l-emerald-400',
    count: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  },
  next_steps: {
    icon: 'text-blue-600 dark:text-blue-400',
    header: 'bg-blue-50 hover:bg-blue-100 text-blue-900 dark:bg-blue-950/40 dark:hover:bg-blue-950/70 dark:text-blue-100',
    edge: 'border-l-blue-500 dark:border-l-blue-400',
    count: 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200',
  },
  risks: {
    icon: 'text-rose-600 dark:text-rose-400',
    header: 'bg-rose-50 hover:bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:hover:bg-rose-950/70 dark:text-rose-100',
    edge: 'border-l-rose-500 dark:border-l-rose-400',
    count: 'bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200',
  },
  meddpicc: {
    icon: 'text-violet-600 dark:text-violet-400',
    header: 'bg-violet-50 hover:bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:hover:bg-violet-950/70 dark:text-violet-100',
    edge: 'border-l-violet-500 dark:border-l-violet-400',
    count: 'bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200',
  },
}

export function AiNoteSectionPicker({ value, onChange, disabled, allowEmpty }: {
  value: AiNoteSection[]
  onChange: (next: AiNoteSection[]) => void
  disabled?: boolean
  // An AI Note profile may have only custom sections (v1.466.0).
  allowEmpty?: boolean
}) {
  const { t } = useTranslation()
  const chosen = new Set(value)
  return (
    <ul className="flex flex-col gap-2">
      {AI_NOTE_SECTIONS.map((s) => {
        const Icon = AI_NOTE_SECTION_ICONS[s]
        const checked = chosen.has(s)
        // At least one section stays chosen.
        const lastOne = !allowEmpty && checked && chosen.size === 1
        return (
          <li key={s}>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || lastOne}
                onChange={(e) => {
                  const next = new Set(chosen)
                  if (e.target.checked) next.add(s)
                  else next.delete(s)
                  onChange(AI_NOTE_SECTIONS.filter((x) => next.has(x)))
                }}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 dark:border-gray-600"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium text-gray-900 dark:text-gray-100">
                  <Icon className={`h-3.5 w-3.5 ${AI_NOTE_SECTION_STYLES[s].icon}`} />
                  {t(`activity.ai_notes.section.${s}`)}
                </span>
                <span className="mt-0.5 block text-xs text-gray-600 dark:text-gray-400">{t(`activity.ai_notes.section_hint.${s}`)}</span>
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}
