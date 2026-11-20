import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Send, AlertTriangle, AlertOctagon } from 'lucide-react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { Button } from '../ui/button.js'
import { Spinner } from '../ui/spinner.js'
import { formatEntry, computeCapacity } from '../../../shared/sfFieldPrepend.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'
import { SfLongTextViewerModal } from './SfLongTextViewerModal.js'
import { useCrmApiBase, useCrmLabelContext } from '../../store/crmProvider.js'

interface FieldPrependMeta {
  fieldLabel: string | null
  maximumCharacters: number | null
  currentValue: string | null
  currentLength: number
  lastModifiedDate: string | null
}

// Live-preview-only initials from displayName — the server independently
// (and authoritatively) derives the real initials from users.firstName/
// lastName at write time; this is purely so the preview line looks right
// before Post is clicked.
function previewInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : '?'
  return `${first}${last}`.toUpperCase()
}

// The "Field / New Update / Preview / Character Status" block — a
// team-configured Salesforce text field where new entries are PREPENDED
// (dated + initialed) above existing content rather than overwriting it.
// Only renders once a mapping for `appField` on `sobject` actually exists
// for this team (an admin sets that up in Admin → SF Field Mappings).
export function SfFieldPrependPanel({
  teamId,
  sobject,
  recordId,
  appField,
  labelFallback,
  disabled,
  onPosted,
}: {
  teamId: string
  sobject: string
  recordId: string
  appField: string
  labelFallback: string
  disabled?: boolean
  onPosted?: () => void
}) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const crmBase = useCrmApiBase()
  const crmCtx = useCrmLabelContext()
  const [meta, setMeta] = useState<FieldPrependMeta | null>(null)
  const [unmapped, setUnmapped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<{ message: string; meta?: Record<string, unknown> } | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)

  async function load() {
    setLoading(true)
    const res = await api.get<FieldPrependMeta>(
      `${crmBase}/field-prepend/meta?teamId=${teamId}&sobject=${encodeURIComponent(sobject)}&appField=${appField}&recordId=${encodeURIComponent(recordId)}`,
    )
    setLoading(false)
    if (res.meta?.['unmapped'] === true) { setUnmapped(true); return }
    if (res.error) { setError({ message: res.error }); return }
    setMeta(res.data)
  }
  useEffect(() => { void load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamId, sobject, recordId, appField, crmBase])

  const todayPreview = useMemo(() => new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' }).format(new Date()), [])
  const initials = previewInitials(user?.displayName ?? '')
  const formattedEntry = text.trim().length > 0 ? formatEntry(todayPreview, initials, text.trim()) : ''
  const capacity = formattedEntry
    ? computeCapacity({ existingValue: meta?.currentValue ?? null, formattedEntry, maxLength: meta?.maximumCharacters ?? null })
    : null

  const pctUsed = capacity?.maximumCharacters ? capacity.charactersUsed / capacity.maximumCharacters : 0
  const level: 'normal' | 'warning' | 'high' | 'over' =
    capacity && !capacity.fits ? 'over' : pctUsed >= 0.9 ? 'high' : pctUsed >= 0.8 ? 'warning' : 'normal'

  async function handlePost() {
    if (!formattedEntry || !capacity?.fits) return
    setPosting(true)
    setError(null)
    const res = await api.post<{ formattedEntry: string }>(`${crmBase}/field-prepend`, {
      teamId, sobject, appField, recordId, text: text.trim(), expectedLastModifiedDate: meta?.lastModifiedDate ?? null,
    })
    setPosting(false)
    if (res.error) {
      setError({ message: res.error, meta: res.meta })
      // Concurrency conflict — refresh so the user sees what actually
      // changed and can retry without losing their typed text (AC8).
      if (res.meta?.['currentValue'] !== undefined) {
        setMeta((prev) => prev && { ...prev, currentValue: res.meta!['currentValue'] as string | null, currentLength: (res.meta!['currentLength'] as number) ?? 0 })
      }
      return
    }
    setText('')
    await load()
    onPosted?.()
  }

  if (unmapped) return null
  if (loading && !meta) {
    return <div className="flex items-center gap-1.5 text-[11px] text-gray-400"><Spinner className="h-3 w-3" /> {t('common.loading', 'Loading…')}</div>
  }

  const fieldLabel = meta?.fieldLabel || labelFallback

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-1.5">
        <label className="text-[11px] font-medium text-gray-600 dark:text-gray-300">{fieldLabel}</label>
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          title={t('salesforce.field_prepend.view_full_text')}
          aria-label={t('salesforce.field_prepend.view_full_text')}
          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled || posting}
        rows={3}
        placeholder={t('salesforce.field_prepend.new_update_placeholder')}
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      />

      {formattedEntry && (
        <div className="rounded bg-gray-50 px-2 py-1.5 text-[11px] text-gray-500 dark:bg-gray-800/60 dark:text-gray-400">
          <span className="font-medium text-gray-400 dark:text-gray-500">{t('salesforce.field_prepend.preview_label')}: </span>
          {formattedEntry}
        </div>
      )}

      {capacity && (
        <p
          className={cn(
            'flex items-center gap-1 text-[11px]',
            level === 'over' && 'text-red-600 dark:text-red-400',
            level === 'high' && 'text-red-500 dark:text-red-400',
            level === 'warning' && 'text-amber-600 dark:text-amber-400',
            level === 'normal' && 'text-gray-400 dark:text-gray-500',
          )}
        >
          {(level === 'warning' || level === 'high' || level === 'over') && <AlertTriangle className="h-3 w-3 shrink-0" />}
          {level === 'over'
            ? t('salesforce.field_prepend.over_limit', { overBy: capacity.overBy, context: crmCtx })
            : capacity.maximumCharacters != null
            ? t('salesforce.field_prepend.remaining', { count: capacity.charactersRemaining ?? 0 })
            : t('salesforce.field_prepend.used', { count: capacity.charactersUsed })}
        </p>
      )}

      {error && (
        <p className="flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400">
          <AlertOctagon className="h-3 w-3 shrink-0" /> {error.message.startsWith('errors.') ? t(error.message) : error.message}
        </p>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void handlePost()} disabled={disabled || posting || !text.trim() || !capacity?.fits}>
          {posting ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          {t('salesforce.field_prepend.post_update')}
        </Button>
      </div>

      {viewerOpen && (
        <SfLongTextViewerModal title={fieldLabel} text={meta?.currentValue ?? null} onClose={() => setViewerOpen(false)} />
      )}
    </div>
  )
}
