import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  AlertCircle, Building2, CalendarCheck, Check, ChevronDown, ChevronRight, Clock, Copy, ExternalLink, Link2, Lock,
  Search, Type, Unlink, UserCheck, Users,
} from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import {
  formatTranscriptOffset,
  gongCallUrlAt,
  type GongActivityCalls,
  type GongCallSummary,
  type GongMatchReason,
  type GongSuggestion,
  type GongTranscriptView,
  type LinkedGongCall,
} from '../../../shared/gong.js'

// The Transcripts tab on the activity drawer (Gong plan, phase 2): the Gong
// calls linked to the activity and their transcripts, or, with nothing
// linked, suggested calls and a search to link one. Only shown when Gong is
// connected and Role Management grants activities.transcripts.

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function TranscriptsTab({ activityId, activityStart, onCountChange }: {
  activityId: string
  activityStart: string
  onCountChange?: (count: number) => void
}) {
  const { t, i18n } = useTranslation()
  const [data, setData] = useState<GongActivityCalls | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [showLinker, setShowLinker] = useState(false)
  const [busyCall, setBusyCall] = useState<string | null>(null)

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '—')
  const minutes = (s: number | null) => (s === null ? null : t('activity.transcripts.minutes', { count: Math.max(1, Math.round(s / 60)) }))

  async function load() {
    const res = await api.get<GongActivityCalls>(`/api/gong/activities/${activityId}/calls`)
    if (res.error) { setError(t(res.error)); return }
    if (!res.data) return
    setData(res.data)
    onCountChange?.(res.data.calls.length)
    setSelected((cur) => (cur && res.data!.calls.some((c) => c.id === cur) ? cur : res.data!.calls[0]?.id ?? null))
  }

  useEffect(() => {
    setData(null)
    setError(null)
    setSelected(null)
    setShowLinker(false)
    let cancelled = false
    void api.get<GongActivityCalls>(`/api/gong/activities/${activityId}/calls`).then((res) => {
      if (cancelled) return
      if (res.error) { setError(t(res.error)); return }
      if (!res.data) return
      setData(res.data)
      onCountChange?.(res.data.calls.length)
      setSelected(res.data.calls[0]?.id ?? null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId])

  async function link(callId: string) {
    setBusyCall(callId)
    setError(null)
    const res = await api.post(`/api/gong/activities/${activityId}/calls`, { gongCallId: callId })
    setBusyCall(null)
    if (res.error) { setError(t(res.error)); return }
    setShowLinker(false)
    setSelected(callId)
    await load()
  }

  async function unlink(callId: string) {
    if (!window.confirm(t('activity.transcripts.unlink_confirm'))) return
    setBusyCall(callId)
    setError(null)
    const res = await api.delete(`/api/gong/activities/${activityId}/calls/${callId}`)
    setBusyCall(null)
    if (res.error) { setError(t(res.error)); return }
    await load()
  }

  if (!data && !error) {
    return <div className="flex justify-center py-8"><Spinner /></div>
  }

  const calls = data?.calls ?? []
  const current = calls.find((c) => c.id === selected) ?? null
  const linker = data?.canLink ? (
    <CallLinker activityId={activityId} activityStart={activityStart} busyCall={busyCall} onLink={link} when={when} minutes={minutes} />
  ) : null

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorBox message={error} /> : null}
      {calls.length === 0 ? (
        <>
          <div className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center dark:border-gray-600">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{t('activity.transcripts.none_title')}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data?.canLink ? t('activity.transcripts.none_hint') : t('activity.transcripts.none_hint_readonly')}
            </p>
          </div>
          {linker}
        </>
      ) : (
        <>
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <Link2 className="h-3.5 w-3.5" />
              {t('activity.transcripts.linked_heading', { count: calls.length })}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {calls.map((c) => (
                <LinkedCallRow
                  key={c.id}
                  call={c}
                  active={c.id === selected}
                  canLink={!!data?.canLink}
                  busy={busyCall === c.id}
                  onSelect={() => setSelected(c.id)}
                  onUnlink={() => void unlink(c.id)}
                  when={when}
                  minutes={minutes}
                />
              ))}
            </ul>
          </section>
          {current ? (
            current.canRead
              ? <TranscriptViewer key={current.id} activityId={activityId} call={current} />
              : <Withheld />
          ) : null}
          {linker ? (
            <div>
              <button
                type="button"
                onClick={() => setShowLinker((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
              >
                {showLinker ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {t('activity.transcripts.link_another')}
              </button>
              {showLinker ? <div className="mt-2">{linker}</div> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function LinkedCallRow({ call, active, canLink, busy, onSelect, onUnlink, when, minutes }: {
  call: LinkedGongCall
  active: boolean
  canLink: boolean
  busy: boolean
  onSelect: () => void
  onUnlink: () => void
  when: (iso: string | null) => string
  minutes: (s: number | null) => string | null
}) {
  const { t } = useTranslation()
  return (
    <li
      className={`flex items-start justify-between gap-2 rounded-md border px-3 py-2 ${active
        ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/40'
        : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'}`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{call.title ?? t('activity.transcripts.untitled')}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-1"><CalendarCheck className="h-3 w-3" />{when(call.startedAt)}</span>
          {minutes(call.durationS) ? <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{minutes(call.durationS)}</span> : null}
          <span className="inline-flex items-center gap-1">
            <Link2 className="h-3 w-3" />
            {t(`activity.transcripts.link_method.${call.linkMethod}`)}
          </span>
          {!call.canRead ? <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />{t('activity.transcripts.withheld_short')}</span> : null}
        </p>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {call.url ? (
          <a
            href={call.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('activity.transcripts.open_in_gong')}
          </a>
        ) : null}
        {canLink ? (
          <button
            type="button"
            onClick={onUnlink}
            disabled={busy}
            title={t('activity.transcripts.unlink')}
            aria-label={t('activity.transcripts.unlink')}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-red-400"
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>
    </li>
  )
}

function Withheld() {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">{t('activity.transcripts.withheld_title')}</p>
        <p className="mt-0.5 text-gray-500 dark:text-gray-400">{t('activity.transcripts.withheld_hint')}</p>
      </div>
    </div>
  )
}

function TranscriptViewer({ activityId, call }: { activityId: string; call: LinkedGongCall }) {
  const { t } = useTranslation()
  const [view, setView] = useState<GongTranscriptView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.get<GongTranscriptView>(`/api/gong/activities/${activityId}/calls/${call.id}/transcript`).then((res) => {
      if (cancelled) return
      if (res.error) setError(t(res.error))
      else setView(res.data ?? null)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId, call.id])

  const speakers = useMemo(() => {
    const map = new Map<string, GongTranscriptView['parties'][number]>()
    for (const p of view?.parties ?? []) if (p.speakerId) map.set(p.speakerId, p)
    return map
  }, [view])

  const topics = useMemo(() => {
    const out: Array<{ topic: string; start: number; index: number }> = []
    view?.monologues.forEach((m, index) => {
      if (m.topic && out[out.length - 1]?.topic !== m.topic) out.push({ topic: m.topic, start: m.sentences[0]?.start ?? 0, index })
    })
    return out
  }, [view])

  if (error) return <ErrorBox message={error} />
  if (!view) return <div className="flex justify-center py-6"><Spinner /></div>

  const speakerName = (id: string | null) => {
    const p = id ? speakers.get(id) : undefined
    return p?.name ?? p?.email ?? t('activity.transcripts.unknown_speaker')
  }

  async function copy() {
    const text = view!.monologues
      .map((m) => `[${formatTranscriptOffset(m.sentences[0]?.start ?? 0)}] ${speakerName(m.speakerId)}: ${m.sentences.map((s) => s.text).join(' ')}`)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError(t('activity.transcripts.copy_failed'))
    }
  }

  return (
    <section className="rounded-md border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Users className="h-3.5 w-3.5" />
          {t('activity.transcripts.speakers', { count: view.parties.length })}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
          {copied ? t('activity.transcripts.copied') : t('activity.transcripts.copy')}
        </Button>
      </div>
      {topics.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          {topics.map((tp) => (
            <a
              key={`${tp.index}-${tp.topic}`}
              href={`#gong-mono-${call.id}-${tp.index}`}
              className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {tp.topic} <span className="text-gray-400 dark:text-gray-500">{formatTranscriptOffset(tp.start)}</span>
            </a>
          ))}
        </div>
      ) : null}
      {view.monologues.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-gray-500 dark:text-gray-400">{t('activity.transcripts.empty_transcript')}</p>
      ) : (
        <ol className="max-h-[28rem] overflow-y-auto px-3 py-2">
          {view.monologues.map((m, i) => {
            const party = m.speakerId ? speakers.get(m.speakerId) : undefined
            const start = m.sentences[0]?.start ?? 0
            const href = gongCallUrlAt(view.url, start)
            return (
              <li key={i} id={`gong-mono-${call.id}-${i}`} className="flex gap-3 py-1.5">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="w-12 shrink-0 pt-0.5 font-mono text-xs text-indigo-700 hover:underline dark:text-indigo-300">
                    {formatTranscriptOffset(start)}
                  </a>
                ) : (
                  <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-gray-400 dark:text-gray-500">{formatTranscriptOffset(start)}</span>
                )}
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-1.5 text-xs">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{speakerName(m.speakerId)}</span>
                    {party?.isImpactIqUser ? (
                      <span className="inline-flex items-center gap-0.5 text-indigo-700 dark:text-indigo-300"><UserCheck className="h-3 w-3" />{t('activity.transcripts.impactiq_user')}</span>
                    ) : party?.affiliation === 'external' ? (
                      <span className="inline-flex items-center gap-0.5 text-gray-500 dark:text-gray-400"><Building2 className="h-3 w-3" />{t('activity.transcripts.external')}</span>
                    ) : null}
                    {party?.title ? <span className="text-gray-500 dark:text-gray-400">· {party.title}</span> : null}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">{m.sentences.map((s) => s.text).join(' ')}</p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <p className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-400 dark:border-gray-700 dark:text-gray-500">{t('activity.transcripts.viewer_hint')}</p>
    </section>
  )
}

function reasonLabel(t: TFunction, r: GongMatchReason): string {
  switch (r.kind) {
    case 'same_meeting': return t('activity.transcripts.reason.same_meeting')
    case 'starts_close':
      if (r.minutes === 0) return t('activity.transcripts.reason.starts_same')
      return r.minutes > 0
        ? t('activity.transcripts.reason.starts_after', { count: r.minutes })
        : t('activity.transcripts.reason.starts_before', { count: -r.minutes })
    case 'owner_on_call': return t('activity.transcripts.reason.owner_on_call')
    case 'attendees': return t('activity.transcripts.reason.attendees', { count: r.count })
    case 'same_record': return t('activity.transcripts.reason.same_record')
    case 'similar_title': return t('activity.transcripts.reason.similar_title')
  }
}

function ReasonIcon({ kind }: { kind: GongMatchReason['kind'] }) {
  const cls = 'h-3 w-3'
  if (kind === 'same_meeting') return <CalendarCheck className={cls} />
  if (kind === 'starts_close') return <Clock className={cls} />
  if (kind === 'owner_on_call') return <UserCheck className={cls} />
  if (kind === 'attendees') return <Users className={cls} />
  if (kind === 'same_record') return <Building2 className={cls} />
  return <Type className={cls} />
}

function CallCard({ call, busy, onLink, when, minutes, suggestion }: {
  call: GongCallSummary
  busy: boolean
  onLink: () => void
  when: (iso: string | null) => string
  minutes: (s: number | null) => string | null
  suggestion?: GongSuggestion
}) {
  const { t } = useTranslation()
  return (
    <li className="rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{call.title ?? t('activity.transcripts.untitled')}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
            <span className="inline-flex items-center gap-1"><CalendarCheck className="h-3 w-3" />{when(call.startedAt)}</span>
            {minutes(call.durationS) ? <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{minutes(call.durationS)}</span> : null}
            {call.hostName ? <span className="inline-flex items-center gap-1"><UserCheck className="h-3 w-3" />{t('activity.transcripts.host', { name: call.hostName })}</span> : null}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onLink} disabled={busy}>
          {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Link2 className="mr-1 h-3.5 w-3.5" />}
          {t('activity.transcripts.link')}
        </Button>
      </div>
      {suggestion ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {suggestion.reasons.map((r, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 dark:bg-gray-800 dark:text-gray-300">
              <ReasonIcon kind={r.kind} />
              {reasonLabel(t, r)}
            </span>
          ))}
          <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('activity.transcripts.score', { score: suggestion.score })}</span>
        </div>
      ) : null}
    </li>
  )
}

function CallLinker({ activityId, activityStart, busyCall, onLink, when, minutes }: {
  activityId: string
  activityStart: string
  busyCall: string | null
  onLink: (callId: string) => void
  when: (iso: string | null) => string
  minutes: (s: number | null) => string | null
}) {
  const { t } = useTranslation()
  const [suggestions, setSuggestions] = useState<GongSuggestion[] | null>(null)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const center = new Date(activityStart)
  const [q, setQ] = useState('')
  const [from, setFrom] = useState(() => toDateInput(new Date(center.getTime() - 3 * 86400000)))
  const [to, setTo] = useState(() => toDateInput(new Date(center.getTime() + 3 * 86400000)))
  const [results, setResults] = useState<GongCallSummary[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.get<GongSuggestion[]>(`/api/gong/activities/${activityId}/suggestions`).then((res) => {
      if (cancelled) return
      if (res.error) setSuggestError(t(res.error))
      else setSuggestions(res.data ?? [])
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId])

  async function search() {
    const fromD = new Date(`${from}T00:00:00`)
    const toD = new Date(`${to}T23:59:59`)
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD > toD) {
      setSearchError(t('activity.transcripts.search_bad_dates'))
      return
    }
    setSearching(true)
    setSearchError(null)
    const params = new URLSearchParams({ from: fromD.toISOString(), to: toD.toISOString() })
    if (q.trim()) params.set('q', q.trim())
    const res = await api.get<GongCallSummary[]>(`/api/gong/activities/${activityId}/search?${params.toString()}`)
    setSearching(false)
    if (res.error) setSearchError(t(res.error))
    else setResults(res.data ?? [])
  }

  return (
    <div className="flex flex-col gap-3">
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('activity.transcripts.suggested_heading', { count: suggestions?.length ?? 0 })}
        </h3>
        {suggestError ? <ErrorBox message={suggestError} /> : suggestions === null ? (
          <div className="flex justify-center py-3"><Spinner /></div>
        ) : suggestions.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('activity.transcripts.no_suggestions')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {suggestions.map((s) => (
              <CallCard key={s.id} call={s} suggestion={s} busy={busyCall === s.id} onLink={() => onLink(s.id)} when={when} minutes={minutes} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{t('activity.transcripts.search_heading')}</h3>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); void search() }}
        >
          <Input
            className="min-w-[10rem] flex-1"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('activity.transcripts.search_placeholder')}
            aria-label={t('activity.transcripts.search_placeholder')}
            maxLength={200}
          />
          <label className="flex flex-col text-[11px] text-gray-500 dark:text-gray-400">
            {t('activity.transcripts.search_from')}
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
          </label>
          <label className="flex flex-col text-[11px] text-gray-500 dark:text-gray-400">
            {t('activity.transcripts.search_to')}
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
          </label>
          <Button type="submit" size="sm" disabled={searching}>
            {searching ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Search className="mr-1 h-3.5 w-3.5" />}
            {t('activity.transcripts.search')}
          </Button>
        </form>
        <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{t('activity.transcripts.search_hint')}</p>
        {searchError ? <div className="mt-2"><ErrorBox message={searchError} /></div> : null}
        {results !== null ? (
          results.length === 0 ? (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('activity.transcripts.no_results')}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {results.map((c) => (
                <CallCard key={c.id} call={c} busy={busyCall === c.id} onLink={() => onLink(c.id)} when={when} minutes={minutes} />
              ))}
            </ul>
          )
        ) : null}
      </section>
    </div>
  )
}
