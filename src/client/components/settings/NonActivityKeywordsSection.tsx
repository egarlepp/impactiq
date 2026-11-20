import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, X, CalendarOff, Plus } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'

// v1.243.0: the user's own Non-Activity subject keywords.
//
// Personal counterpart to a team keyword rule with action='mark_non_activity'
// (Admin → Keyword Rules). Those apply to everyone on the team; this list
// applies to this user's ImpactIQ only, for the recurring meetings that are
// genuinely not work *for them* — a manager 1:1, a personal block — which
// nobody else should have filtered out of their own list.
//
// Evaluated after the admin rules and before the AI classifier: an admin rule
// that assigns a real activity type still wins, but an explicit instruction
// from the user outranks a guess.
export function NonActivityKeywordsSection() {
  const { t } = useTranslation()
  const [keywords, setKeywords] = useState<string[]>([])
  const [raw, setRaw] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await api.get<{ keywords: string[] }>('/api/auth/me/non-activity-keywords')
      if (cancelled) return
      const list = res.data?.keywords ?? []
      setKeywords(list)
      setRaw(list.join(', '))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  // Parsed from the field on every keystroke so the chip preview below always
  // reflects what a save would actually store — including the de-duping, which
  // is otherwise invisible until after the round trip.
  const parsed = (() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const part of raw.split(',')) {
      const k = part.trim()
      if (!k) continue
      const lower = k.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      out.push(k)
    }
    return out
  })()

  const dirty = parsed.join('\u0000') !== keywords.join('\u0000')

  async function save() {
    setSaving(true)
    try {
      const res = await api.patch<{ keywords: string[] }>('/api/auth/me/non-activity-keywords', { keywords: parsed })
      const list = res.data?.keywords ?? parsed
      setKeywords(list)
      setRaw(list.join(', '))
      setSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    setRaw(keywords.join(', '))
  }

  if (loading) return <div className="flex justify-center py-4"><Spinner className="h-5 w-5" /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Input
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setSavedAt(null) }}
          placeholder={t('settings.non_activity_keywords.placeholder')}
          aria-label={t('settings.non_activity_keywords.section_title')}
        />
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {t('settings.non_activity_keywords.hint')}
        </p>
      </div>

      {/* Chip preview of exactly what will be stored — the field is one comma
          string, so without this it isn't obvious where one keyword ends and
          the next begins (or that a duplicate got collapsed). */}
      {parsed.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {parsed.map((k) => (
            <span
              key={k.toLowerCase()}
              className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
            >
              <CalendarOff className="h-3 w-3 shrink-0 text-gray-500 dark:text-gray-400" />
              {k}
            </span>
          ))}
        </div>
      )}
      {parsed.length === 0 && (
        <p className="flex items-center gap-1.5 text-[11px] italic text-gray-400 dark:text-gray-500">
          <Plus className="h-3 w-3" />
          {t('settings.non_activity_keywords.empty')}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          {t('common.save')}
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={reset} disabled={saving}>
            <X className="mr-1 h-3.5 w-3.5" />
            {t('common.cancel')}
          </Button>
        )}
        {savedAt && !dirty && (
          <span className="text-[11px] text-green-600 dark:text-green-400">
            {t('settings.non_activity_keywords.saved')}
          </span>
        )}
      </div>
    </div>
  )
}
