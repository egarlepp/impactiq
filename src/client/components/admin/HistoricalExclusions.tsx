import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import {
  Ban,
  Plus,
  Power,
  PowerOff,
  Trash2,
  X,
  UserCog,
  UserRound,
  CheckCircle2,
  AlertTriangle,
  Users,
  Loader2,
} from 'lucide-react'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Dialog } from '../ui/dialog.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import { HUBSPOT_HISTORICAL_ACTOR_RX } from '../../../shared/hubspot.js'

// v1.215.0: admin management of which Salesforce Events the historical import
// skips.
//
// This exists because integration users are indistinguishable from people in
// Salesforce — "Outreach" has UserType Standard and a System Administrator
// profile — so there is no rule to infer, only a list to maintain. In the
// one production org, Outreach alone accounted for a third of the events the import
// would otherwise pull.
//
// Each card owns its `kind`, so there's no kind picker anywhere in the UI and
// no way to add a rule to the wrong list.

export type ExclusionKind = 'created_by' | 'owner'

export interface ExclusionRule {
  kind: string
  crmUserId: string
  label: string | null
  note: string | null
  isActive: boolean
  lastPurgedAt: string | null
  purgedCount: number
}

export interface TopCreator {
  createdByCrmUserId: string | null
  createdByName: string | null
  count: number
  estimatedHours: number
  alreadyExcluded: boolean
}

interface PurgeTarget {
  kind: ExclusionKind
  crmUserId: string
  label: string
  matchedRows: number
  estimatedHours: number
  matchedRowsNullCreatedBy: number
}

const SF_ID_RX = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/

// On HubSpot an exclusion id is an owner id, or user:<id> / source:<id> for a
// meeting created by a HubSpot user with no owner record or by an app (v1.401.0).
function validExclusionId(id: string, crmCtx: string | undefined): boolean {
  return crmCtx === 'hubspot' ? HUBSPOT_HISTORICAL_ACTOR_RX.test(id) : SF_ID_RX.test(id)
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id
}

export function HistoricalExclusions({
  exclusions,
  topCreators,
  unpurgedMatches,
  onChanged,
}: {
  exclusions: ExclusionRule[]
  topCreators: TopCreator[]
  unpurgedMatches: number
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purge, setPurge] = useState<PurgeTarget | null>(null)

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const add = (kind: ExclusionKind, crmUserId: string, label: string) =>
    call(async () => {
      await api.post('/api/admin/historical-import/exclusions', {
        kind,
        crmUserId,
        label: label || undefined,
      })
    })

  const openPurge = async (kind: ExclusionKind, crmUserId: string, label: string) => {
    setError(null)
    try {
      const res = await api.get<{
        matchedRows: number
        estimatedHours: number
        matchedRowsNullCreatedBy: number
      }>(`/api/admin/historical-import/exclusions/${kind}/${encodeURIComponent(crmUserId)}/preview`)
      setPurge({
        kind,
        crmUserId,
        label,
        matchedRows: res.data?.matchedRows ?? 0,
        estimatedHours: res.data?.estimatedHours ?? 0,
        matchedRowsNullCreatedBy: res.data?.matchedRowsNullCreatedBy ?? 0,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const confirmPurge = () => {
    if (!purge) return
    void call(async () => {
      // expectedCount makes the confirmation real: if a backfill landed
      // between preview and confirm, the server 409s instead of deleting a
      // different number than the admin agreed to.
      await api.post(
        `/api/admin/historical-import/exclusions/${purge.kind}/${encodeURIComponent(purge.crmUserId)}/purge`,
        { confirm: true, expectedCount: purge.matchedRows },
      )
      setPurge(null)
    })
  }

  return (
    <div className="space-y-4">
      {unpurgedMatches > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('admin.historical_import.exclusions.unpurged', { count: unpurgedMatches })}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ExclusionCard
          kind="created_by"
          icon={UserCog}
          title={t('admin.historical_import.exclusions.created_by_title')}
          help={t('admin.historical_import.exclusions.created_by_help', { context: crmCtx })}
          rules={exclusions.filter((e) => e.kind === 'created_by')}
          busy={busy}
          onAdd={add}
          onToggle={(k, id, isActive) =>
            call(() => api.patch(`/api/admin/historical-import/exclusions/${k}/${encodeURIComponent(id)}`, { isActive }))
          }
          onRemove={(k, id) => call(() => api.delete(`/api/admin/historical-import/exclusions/${k}/${encodeURIComponent(id)}`))}
          onPurge={openPurge}
        />
        <ExclusionCard
          kind="owner"
          icon={UserRound}
          title={t('admin.historical_import.exclusions.owner_title')}
          help={t('admin.historical_import.exclusions.owner_help', { context: crmCtx })}
          rules={exclusions.filter((e) => e.kind === 'owner')}
          busy={busy}
          onAdd={add}
          onToggle={(k, id, isActive) =>
            call(() => api.patch(`/api/admin/historical-import/exclusions/${k}/${encodeURIComponent(id)}`, { isActive }))
          }
          onRemove={(k, id) => call(() => api.delete(`/api/admin/historical-import/exclusions/${k}/${encodeURIComponent(id)}`))}
          onPurge={openPurge}
        />
      </div>

      {/* Discovery: what the imported data says, so nobody has to hunt for
          User Ids in Salesforce. */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Users className="h-4 w-4" />
            {t('admin.historical_import.discovery.title')}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('admin.historical_import.discovery.subtitle', { context: crmCtx })}
          </p>
        </div>
        {topCreators.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-gray-500 dark:text-gray-400">
            {t('admin.historical_import.discovery.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 text-xs dark:divide-gray-800">
            {topCreators.map((c, i) => (
              <li key={`${c.createdByCrmUserId ?? 'none'}-${i}`} className="flex items-center gap-2 px-4 py-1.5">
                <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                  {c.createdByName ?? c.createdByCrmUserId ?? t('admin.historical_import.discovery.unknown')}
                </span>
                <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">{c.count}</span>
                <span className="w-24 shrink-0 text-right tabular-nums text-amber-700 dark:text-amber-400">
                  ~{Math.round(c.estimatedHours)}h
                </span>
                <span className="w-24 shrink-0 text-right">
                  {c.alreadyExcluded ? (
                    <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                      <CheckCircle2 className="h-3 w-3" />
                      {t('admin.historical_import.discovery.excluded')}
                    </span>
                  ) : (
                    c.createdByCrmUserId && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void add('created_by', c.createdByCrmUserId!, c.createdByName ?? '')}
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                      >
                        <Ban className="h-3 w-3" />
                        {t('admin.historical_import.discovery.exclude')}
                      </button>
                    )
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <Dialog
        open={!!purge}
        onClose={() => setPurge(null)}
        title={t('admin.historical_import.purge.title')}
        titleIcon={Trash2}
      >
        {purge && (
          <div className="space-y-3 p-6 text-sm">
            {purge.matchedRows === 0 ? (
              <p className="text-gray-600 dark:text-gray-300">
                {t('admin.historical_import.purge.nothing')}
              </p>
            ) : (
              <p className="text-gray-700 dark:text-gray-200">
                {t('admin.historical_import.purge.body', {
                  count: purge.matchedRows,
                  hours: Math.round(purge.estimatedHours),
                  name: purge.label || purge.crmUserId,
                })}
              </p>
            )}
            {purge.matchedRowsNullCreatedBy > 0 && (
              <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                {t('admin.historical_import.purge.unknown_creator', {
                  count: purge.matchedRowsNullCreatedBy,
                })}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setPurge(null)}>
                <X className="mr-1 h-3.5 w-3.5" />
                {t('admin.historical_import.purge.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || purge.matchedRows === 0}
                onClick={confirmPurge}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {t('admin.historical_import.purge.confirm', { count: purge.matchedRows })}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}

interface SfUserHit { id: string; name: string; email: string | null }

// v1.223.0: name search for the exclusion "Add" row. Excluding someone by
// Salesforce Id was the only option before this — technically correct, since
// the Id is what the SOQL clause matches on, but it means an admin has to go
// find and paste an 18-char Id out of Salesforce first. The app already
// mirrors the SF User directory locally (`crm_users`, kept current by the
// Sales Team Alignment sync), so search-by-name works for the same
// integration accounts (Outreach, ZoomInfo, …) an admin is trying to
// exclude — they're ordinary IsActive=true User rows, same as anyone else.
//
// Kept alongside the raw-Id input rather than replacing it: a departed
// employee's User row may already be inactive and absent from the cache
// (the search filters isActive=true), and pasting an Id from a Salesforce
// URL still has to keep working.
function SfUserSearch({ onPick, disabled }: { onPick: (u: SfUserHit) => void; disabled?: boolean }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [hits, setHits] = useState<SfUserHit[]>([])
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); setOpen(false); return }
    let cancelled = false
    setLoading(true)
    const h = setTimeout(() => {
      void api.get<SfUserHit[]>(`/api/admin/sf-users?q=${encodeURIComponent(query.trim())}&limit=50`)
        .then((res) => { if (!cancelled) { setHits(res.data ?? []); setOpen(true) } })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(h) }
  }, [query])

  useEffect(() => {
    if (!open || !rootRef.current) return
    const r = rootRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 4, left: r.left, width: r.width })
  }, [open, hits])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const t2 = e.target as Node
      if (rootRef.current?.contains(t2)) return
      if (popRef.current?.contains(t2)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={rootRef} className="relative w-56">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (hits.length > 0) setOpen(true) }}
        placeholder={t('admin.historical_import.exclusions.search_placeholder')}
        disabled={disabled}
        className="text-xs"
      />
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
          className="z-[100] max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {loading ? (
            <div className="flex items-center gap-1.5 px-3 py-2 text-gray-500 dark:text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('admin.historical_import.exclusions.search_loading')}
            </div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2 text-gray-400 dark:text-gray-500">
              {t('admin.historical_import.exclusions.search_empty', { context: crmCtx })}
            </div>
          ) : (
            hits.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { onPick(u); setQuery(''); setHits([]); setOpen(false) }}
                className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <span className="truncate text-gray-800 dark:text-gray-200">{u.name}</span>
                {u.email && <span className="truncate text-[10px] text-gray-400 dark:text-gray-500">{u.email}</span>}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

function ExclusionCard({
  kind,
  icon: Icon,
  title,
  help,
  rules,
  busy,
  onAdd,
  onToggle,
  onRemove,
  onPurge,
}: {
  kind: ExclusionKind
  icon: React.ComponentType<{ className?: string }>
  title: string
  help: string
  rules: ExclusionRule[]
  busy: boolean
  onAdd: (kind: ExclusionKind, crmUserId: string, label: string) => void
  onToggle: (kind: ExclusionKind, crmUserId: string, isActive: boolean) => void
  onRemove: (kind: ExclusionKind, crmUserId: string) => void
  onPurge: (kind: ExclusionKind, crmUserId: string, label: string) => void
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const valid = validExclusionId(id.trim(), crmCtx)

  return (
    <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Icon className="h-4 w-4" />
          {title}
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400">{help}</p>
      </div>

      {rules.length === 0 ? (
        <p className="px-4 py-4 text-center text-xs text-gray-500 dark:text-gray-400">
          {t('admin.historical_import.exclusions.none')}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {rules.map((r) => (
            <li key={r.crmUserId} className="flex items-center gap-2 px-4 py-2 text-xs">
              <button
                type="button"
                disabled={busy}
                onClick={() => onToggle(kind, r.crmUserId, !r.isActive)}
                title={r.isActive
                  ? t('admin.historical_import.exclusions.disable')
                  : t('admin.historical_import.exclusions.enable')}
                aria-label={r.isActive
                  ? t('admin.historical_import.exclusions.disable')
                  : t('admin.historical_import.exclusions.enable')}
                className={cn(
                  'shrink-0 disabled:opacity-50',
                  r.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-600',
                )}
              >
                {r.isActive ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
              </button>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate', !r.isActive && 'text-gray-400 dark:text-gray-500')}>
                  {r.label ?? r.crmUserId}
                </span>
                <span className="block font-mono text-[10px] text-gray-400 dark:text-gray-500" title={r.crmUserId}>
                  {shortId(r.crmUserId)}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPurge(kind, r.crmUserId, r.label ?? r.crmUserId)}
                className="inline-flex shrink-0 items-center gap-1 text-gray-500 hover:text-red-600 disabled:opacity-50 dark:text-gray-400 dark:hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
                {t('admin.historical_import.exclusions.purge')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(kind, r.crmUserId)}
                title={t('admin.historical_import.exclusions.remove')}
                aria-label={t('admin.historical_import.exclusions.remove')}
                className="shrink-0 text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* v1.223.0: search by name first — the app already mirrors the SF User
          directory locally, so an admin shouldn't have to go find and paste an
          18-char Id out of Salesforce. Picking a result fills both id and
          label; the raw-Id field stays for the case search can't cover (a
          departed employee whose User row is inactive and so absent from the
          cache, or a fresh sync that hasn't run yet). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 px-4 pt-3 dark:border-gray-700">
        <SfUserSearch
          disabled={busy}
          onPick={(u) => { setId(u.id); setLabel(u.name) }}
        />
        <span className="text-[11px] text-gray-400 dark:text-gray-500">{t('admin.historical_import.exclusions.search_or', { context: crmCtx })}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-2">
        <Input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={t('admin.historical_import.exclusions.add_placeholder', { context: crmCtx })}
          className="w-56 font-mono text-xs"
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('admin.historical_import.exclusions.label_placeholder')}
          className="w-40 text-xs"
        />
        <Button
          size="sm"
          disabled={busy || !valid}
          onClick={() => {
            onAdd(kind, id.trim(), label.trim())
            setId('')
            setLabel('')
          }}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('admin.historical_import.exclusions.add')}
        </Button>
        {id.trim() && !valid && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            {t('admin.historical_import.exclusions.invalid_id', { context: crmCtx })}
          </span>
        )}
      </div>
    </div>
  )
}
