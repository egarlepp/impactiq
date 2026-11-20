import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import {
  Briefcase, Building2, CalendarClock, CircleDollarSign, ExternalLink, Factory,
  Globe, Loader2, MapPin, RefreshCw, Signal, Target, Trophy, User, UserCog, XCircle,
} from 'lucide-react'
import { evalTypeIcon } from '../../lib/sf-icons.js'
import { api } from '../../lib/api.js'
import { crmApiBase, useCrmLabelContext, useCrmRecordLinkBase } from '../../store/crmProvider.js'
import { HUBSPOT_OBJECT_TYPE_IDS } from '../../../shared/hubspot.js'
import { useCurrentUser } from '../../hooks/useCurrentUser.js'

// v1.218.0: inline Salesforce record preview. Hovering (or keyboard-focusing)
// the Opportunity / Account name on an activity card opens a small popover
// with the record's current state — stage, forecast, ACV, close date, owner,
// Assigned SE — so an SE checking "is this deal still live?" doesn't have to
// leave the weekly view for a Salesforce tab.
//
// Deliberately hover/focus rather than click: the card's SF links already
// have a click action (the SF Activities modal), and the point of a preview
// is that it costs nothing to glance at. On touch devices, where there is no
// hover, the click path is unchanged and nothing is lost.
//
// The server always answers with something (local snapshot floor, live read
// layered on top when the user's own SF connection works), so this component
// has no error state — only "loading" and "here it is, from this source".

// v1.222.0: 'Project' is the Evaluation-style child object an activity links
// to via crmRelatedId. Its SF API name varies per org (Evaluations__c in a
// typical org), so the caller passes `sobject` — never hardcoded here, per
// CLAUDE.md §21.
export type SfPreviewType = 'Opportunity' | 'Account' | 'Project'

/** Eval field values already snapshotted on the activity row. */
export interface ProjectSeed {
  status?: string | null
  stage?: string | null
  evalType?: string | null
  startDate?: string | null
  endDate?: string | null
  primaryEngineer?: string | null
}

interface SfPreviewData {
  id: string
  type: SfPreviewType
  name: string | null
  accountId: string | null
  accountName: string | null
  stageName: string | null
  forecastCategory: string | null
  amount: string | null
  acv: string | null
  closeDate: string | null
  isClosed: boolean | null
  isWon: boolean | null
  ownerName: string | null
  assignedSeName: string | null
  primaryEngineerName: string | null
  // v1.277.0: null = unknown (no name to check, e.g. field unmapped), true =
  // an ImpactIQ user shares this display name, false = nobody does — the
  // card renders assignedSeName/primaryEngineerName in red when false.
  assignedSeMatched: boolean | null
  primaryEngineerMatched: boolean | null
  industry: string | null
  accountType: string | null
  website: string | null
  city: string | null
  country: string | null
  // Project (Evaluation) — resolved through crm_field_mappings server-side, so
  // an org that maps different API names still populates these.
  evalStatus: string | null
  evalStage: string | null
  evalType: string | null
  evalStartDate: string | null
  evalEndDate: string | null
  source: 'live' | 'snapshot'
  asOf: string | null
}

/** Shape returned by GET /api/salesforce/evaluations/:relatedId. */
interface EvalPayload {
  eval_name?: string | null
  eval_status?: string | null
  eval_stage?: string | null
  eval_type?: string | null
  eval_start_date?: string | null
  eval_end_date?: string | null
  eval_primary_engineer?: string | null
}

/** The activity's own eval snapshot — the floor a Project preview renders from. */
function fromSeed(id: string, name: string | null, seed: ProjectSeed | undefined): SfPreviewData {
  return {
    id, type: 'Project', name,
    accountId: null, accountName: null, stageName: null, forecastCategory: null,
    amount: null, acv: null, closeDate: null, isClosed: null, isWon: null,
    ownerName: null, assignedSeName: null, primaryEngineerName: seed?.primaryEngineer ?? null,
    assignedSeMatched: null, primaryEngineerMatched: null,
    industry: null, accountType: null, website: null, city: null, country: null,
    evalStatus: seed?.status ?? null,
    evalStage: seed?.stage ?? null,
    evalType: seed?.evalType ?? null,
    evalStartDate: seed?.startDate ?? null,
    evalEndDate: seed?.endDate ?? null,
    source: 'snapshot', asOf: null,
  }
}

// Module-level cache so re-hovering the same record (or two cards in the same
// week linked to one opportunity) doesn't re-query Salesforce. Short TTL —
// the whole value of the popover is that it reflects current CRM state.
const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; data: SfPreviewData }>()
const inflight = new Map<string, Promise<SfPreviewData | null>>()

function cacheKey(type: SfPreviewType, id: string) { return `${type}:${id}` }

interface LoadOpts {
  /** Project only: the org's SF object API name for the Evaluation record. */
  sobject?: string | null
  /** Project only: needed to resolve that team's eval field mappings. */
  teamId?: string | null
  /** Project only: local snapshot floor from the activity row. */
  seed?: ProjectSeed
  seedName?: string | null
}

async function loadPreview(
  type: SfPreviewType,
  id: string,
  force: boolean,
  opts: LoadOpts = {},
): Promise<SfPreviewData | null> {
  const key = cacheKey(type, id)
  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data
    const pending = inflight.get(key)
    if (pending) return pending
  }
  const p = (async () => {
    if (type === 'Project') {
      // Reuses the existing per-user evaluations read, which already resolves
      // every field API name through crm_field_mappings and drops any the org
      // doesn't actually have. A second implementation would drift from the
      // Project panel in the edit drawer, which shows the same data.
      const floor = fromSeed(id, opts.seedName ?? null, opts.seed)
      // Without a team or sobject there is nothing to query — return the
      // snapshot but DON'T cache it, so a later render that does have them
      // isn't stuck behind a stale entry.
      if (!opts.sobject || !opts.teamId) return floor
      const qs = new URLSearchParams({ teamId: opts.teamId, sobject: opts.sobject })
      const res = await api
        .get<EvalPayload | null>(`${crmApiBase()}/evaluations/${encodeURIComponent(id)}?${qs.toString()}`)
        .catch(() => ({ data: null as EvalPayload | null, meta: undefined }))
      // HubSpot sends raw values plus their display labels (owner names,
      // option labels); show the labels.
      const labels = (res.meta as { labels?: Partial<EvalPayload> } | undefined)?.labels
      const d = res.data ? { ...res.data, ...(labels ?? {}) } : null
      // Merged field by field, so an org that hasn't mapped (say) eval_stage
      // keeps the snapshot value instead of losing it on hover.
      const merged: SfPreviewData = { ...floor }
      if (d) {
        merged.source = 'live'
        if (d.eval_name) merged.name = d.eval_name
        if (d.eval_status) merged.evalStatus = d.eval_status
        if (d.eval_stage) merged.evalStage = d.eval_stage
        if (d.eval_type) merged.evalType = d.eval_type
        if (d.eval_start_date) merged.evalStartDate = d.eval_start_date
        if (d.eval_end_date) merged.evalEndDate = d.eval_end_date
        if (d.eval_primary_engineer) merged.primaryEngineerName = d.eval_primary_engineer
      }
      cache.set(key, { at: Date.now(), data: merged })
      return merged
    }
    const res = await api.get<SfPreviewData>(`${crmApiBase()}/preview/${type}/${encodeURIComponent(id)}`)
    if (res.data) cache.set(key, { at: Date.now(), data: res.data })
    return res.data ?? null
  })().finally(() => { inflight.delete(key) })
  inflight.set(key, p)
  return p
}

const HOVER_OPEN_MS = 350
const HOVER_CLOSE_MS = 180
const POP_WIDTH = 300

export function SfRecordPreview({
  type,
  id,
  fallbackName,
  sobject,
  teamId,
  seed,
  children,
}: {
  type: SfPreviewType
  id: string
  /** Name already on the card — renders in the header while the fetch runs. */
  fallbackName?: string | null
  /** Project only: the org's SF object API name (e.g. Evaluations__c). */
  sobject?: string | null
  /** Project only: the team whose field mappings resolve the eval fields. */
  teamId?: string | null
  /** Project only: eval values already on the activity row. */
  seed?: ProjectSeed
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { user } = useCurrentUser()
  const crmCtx = useCrmLabelContext()
  const hubspotLinkBase = useCrmRecordLinkBase()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SfPreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  // Only consumed inside the fetch effect / refresh; every value is a
  // primitive already tracked by the effect's dep list.
  const loadOpts: LoadOpts = { sobject, teamId, seed, seedName: fallbackName ?? null }

  function clearTimers() {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  useEffect(() => clearTimers, [])

  function scheduleOpen() {
    clearTimers()
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_MS)
  }
  function scheduleClose() {
    clearTimers()
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_MS)
  }

  // Fetch on first open; the module cache makes subsequent opens instant.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const hit = cache.get(cacheKey(type, id))
    if (hit && Date.now() - hit.at < TTL_MS) { setData(hit.data); return }
    setLoading(true)
    void loadPreview(type, id, false, loadOpts)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { /* server floors on the snapshot; nothing to show is fine */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // loadOpts is derived from primitives already listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type, id, sobject, teamId])

  async function refresh() {
    setLoading(true)
    try {
      const d = await loadPreview(type, id, true, loadOpts)
      setData(d)
    } catch { /* keep whatever is on screen */ }
    setLoading(false)
  }

  // Flip above the trigger when there isn't room below, and clamp
  // horizontally so a card near the right edge doesn't push the popover
  // off-screen.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) { setPos(null); return }
    const r = wrapRef.current.getBoundingClientRect()
    const MARGIN = 8
    const ESTIMATED_HEIGHT = 230
    const below = window.innerHeight - r.bottom
    const top = below < ESTIMATED_HEIGHT + MARGIN && r.top > ESTIMATED_HEIGHT + MARGIN
      ? r.top - ESTIMATED_HEIGHT - 4
      : r.bottom + 4
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - POP_WIDTH - MARGIN))
    setPos({ top, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    function onScroll() { setOpen(false) }
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const sfBase = user?.sfInstanceUrl ? user.sfInstanceUrl.replace(/\/$/, '') : null
  // Salesforce Lightning routes by object API name, which for a Project is the
  // org's own custom object rather than the literal string 'Project'.
  const sfObjectForLink = type === 'Project' ? (sobject ?? '') : type
  // On HubSpot the link opens the Deal or Company in the portal.
  const hubspotObjectTypeId = type === 'Opportunity' ? HUBSPOT_OBJECT_TYPE_IDS.deals : type === 'Account' ? HUBSPOT_OBJECT_TYPE_IDS.companies : null
  const recordHref = hubspotLinkBase
    ? (hubspotObjectTypeId ? `${hubspotLinkBase}/${hubspotObjectTypeId}/${encodeURIComponent(id)}` : null)
    : (sfBase && sfObjectForLink ? `${sfBase}/lightning/r/${sfObjectForLink}/${id}/view` : null)
  const name = data?.name ?? fallbackName ?? null

  return (
    <>
      <span
        ref={wrapRef}
        // Not `display: contents` — getBoundingClientRect() returns a zero
        // rect on a contents box, which would park the popover at 0,0.
        className="inline-flex min-w-0 max-w-full items-center"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocusCapture={scheduleOpen}
        onBlurCapture={scheduleClose}
      >
        {children}
      </span>
      {open && pos && createPortal(
        <div
          ref={popRef}
          role="tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: POP_WIDTH }}
          className="z-[100] rounded-lg border border-gray-200 bg-white p-3 text-xs normal-case tracking-normal shadow-lg dark:border-gray-700 dark:bg-gray-900"
          onMouseEnter={clearTimers}
          onMouseLeave={scheduleClose}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-start gap-1.5 border-b border-gray-100 pb-2 dark:border-gray-800">
            {type === 'Opportunity'
              ? <Briefcase className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
              : type === 'Project'
              ? <HeaderProjectIcon evalType={data?.evalType ?? seed?.evalType ?? null} />
              : <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />}
            <span className="min-w-0 flex-1 break-words font-semibold text-gray-900 dark:text-gray-100">
              {name ?? t('sf_preview.unnamed')}
            </span>
            {recordHref && (
              <a
                href={recordHref}
                target="_blank"
                rel="noopener noreferrer"
                title={t('sf_preview.open_in_sf', { context: crmCtx })}
                aria-label={t('sf_preview.open_in_sf', { context: crmCtx })}
                className="shrink-0 rounded p-0.5 text-blue-600 hover:bg-gray-100 dark:text-blue-400 dark:hover:bg-gray-800"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          {loading && !data ? (
            <div className="flex items-center gap-2 py-2 text-gray-500 dark:text-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('sf_preview.loading', { context: crmCtx })}
            </div>
          ) : !data ? (
            <div className="py-2 italic text-gray-400 dark:text-gray-500">{t('sf_preview.unavailable', { context: crmCtx })}</div>
          ) : type === 'Opportunity' ? (
            <OpportunityBody data={data} />
          ) : type === 'Project' ? (
            <ProjectBody data={data} />
          ) : (
            <AccountBody data={data} />
          )}

          {data && (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-gray-100 pt-2 text-[10px] text-gray-400 dark:border-gray-800 dark:text-gray-500">
              <span className="flex items-center gap-1">
                <Signal className="h-3 w-3 shrink-0" />
                {data.source === 'live'
                  ? t('sf_preview.source_live', { context: crmCtx })
                  : data.asOf
                  ? t('sf_preview.source_as_of', { date: format(new Date(data.asOf), 'MMM d, yyyy') })
                  : t('sf_preview.source_snapshot', { context: crmCtx })}
              </span>
              <button
                type="button"
                onClick={() => { void refresh() }}
                disabled={loading}
                title={t('sf_preview.refresh')}
                className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                {t('sf_preview.refresh')}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="flex w-[92px] shrink-0 items-center gap-1 text-gray-500 dark:text-gray-400">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-200">{children}</span>
    </div>
  )
}

function money(v: string | null): string | null {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function OpportunityBody({ data }: { data: SfPreviewData }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const value = money(data.acv) ?? money(data.amount)
  // Only flag an overdue close date on an OPEN opp — a closed deal whose
  // close date is in the past is just a closed deal.
  const overdue = !!data.closeDate && data.isClosed === false && new Date(data.closeDate) < new Date()
  return (
    <div className="space-y-0.5">
      {data.accountName && (
        <Row icon={<Building2 className="h-3 w-3 shrink-0" />} label={t('sf_preview.account', { context: crmCtx })}>
          {data.accountName}
        </Row>
      )}
      {data.stageName && (
        <Row icon={<Signal className="h-3 w-3 shrink-0" />} label={t('sf_preview.stage')}>
          <span className="inline-flex items-center gap-1">
            {data.stageName}
            {data.isClosed && data.isWon && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-950/50 dark:text-green-300">
                <Trophy className="h-2.5 w-2.5" />
                {t('sf_preview.won')}
              </span>
            )}
            {data.isClosed && data.isWon === false && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800 dark:bg-red-950/50 dark:text-red-300">
                <XCircle className="h-2.5 w-2.5" />
                {t('sf_preview.lost')}
              </span>
            )}
          </span>
        </Row>
      )}
      {data.forecastCategory && (
        <Row icon={<Signal className="h-3 w-3 shrink-0" />} label={t('sf_preview.forecast')}>
          {data.forecastCategory}
        </Row>
      )}
      {value && (
        <Row icon={<CircleDollarSign className="h-3 w-3 shrink-0" />} label={t('sf_preview.value')}>
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">{value}</span>
        </Row>
      )}
      {data.closeDate && (
        <Row icon={<CalendarClock className="h-3 w-3 shrink-0" />} label={t('sf_preview.close_date')}>
          <span className={overdue ? 'font-medium text-amber-700 dark:text-amber-400' : undefined}
                title={overdue ? t('sf_preview.overdue_hint', { context: crmCtx }) : undefined}>
            {format(new Date(data.closeDate), 'MMM d, yyyy')}
          </span>
        </Row>
      )}
      {data.ownerName && (
        <Row icon={<User className="h-3 w-3 shrink-0" />} label={t('sf_preview.owner')}>
          {data.ownerName}
        </Row>
      )}
      {data.assignedSeName && (
        <Row icon={<UserCog className="h-3 w-3 shrink-0" />} label={t('sf_preview.assigned_se')}>
          <span
            className={data.assignedSeMatched === false ? 'text-red-600 dark:text-red-400' : undefined}
            title={data.assignedSeMatched === false ? t('sf_preview.not_in_impactiq', 'Not an ImpactIQ user') : undefined}
          >
            {data.assignedSeName}
          </span>
        </Row>
      )}
      {data.primaryEngineerName && (
        <Row icon={<UserCog className="h-3 w-3 shrink-0" />} label={t('sf_preview.primary_engineer')}>
          <span
            className={data.primaryEngineerMatched === false ? 'text-red-600 dark:text-red-400' : undefined}
            title={data.primaryEngineerMatched === false ? t('sf_preview.not_in_impactiq', 'Not an ImpactIQ user') : undefined}
          >
            {data.primaryEngineerName}
          </span>
        </Row>
      )}
    </div>
  )
}

// Icon mirrors the card's Project chip, which already reflects
// Evaluation_Type__c (POC / Virtual Lab / RTU / …), so the popover and the
// chip it opened from agree at a glance.
function HeaderProjectIcon({ evalType }: { evalType: string | null }) {
  const Icon = evalTypeIcon(evalType) ?? Target
  return <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
}

function ProjectBody({ data }: { data: SfPreviewData }) {
  const { t } = useTranslation()
  const anything = data.evalStatus || data.evalStage || data.evalType || data.evalStartDate || data.evalEndDate || data.primaryEngineerName
  if (!anything) {
    // Either the team has no eval field mappings or the record is genuinely
    // empty. Say so rather than showing a blank box.
    return <div className="py-2 italic text-gray-400 dark:text-gray-500">{t('sf_preview.project_no_details')}</div>
  }
  // A Project whose end date has passed is the thing most worth catching at a
  // glance, so flag it the same way an overdue opportunity close date is.
  const overdue = !!data.evalEndDate && new Date(data.evalEndDate) < new Date()
  return (
    <div className="space-y-0.5">
      {data.evalType && (
        <Row icon={<Target className="h-3 w-3 shrink-0" />} label={t('sf_preview.project_type')}>
          {data.evalType}
        </Row>
      )}
      {data.evalStatus && (
        <Row icon={<Signal className="h-3 w-3 shrink-0" />} label={t('sf_preview.project_status')}>
          {data.evalStatus}
        </Row>
      )}
      {data.evalStage && (
        <Row icon={<Signal className="h-3 w-3 shrink-0" />} label={t('sf_preview.project_stage')}>
          {data.evalStage}
        </Row>
      )}
      {data.evalStartDate && (
        <Row icon={<CalendarClock className="h-3 w-3 shrink-0" />} label={t('sf_preview.project_start')}>
          {format(new Date(data.evalStartDate), 'MMM d, yyyy')}
        </Row>
      )}
      {data.evalEndDate && (
        <Row icon={<CalendarClock className="h-3 w-3 shrink-0" />} label={t('sf_preview.project_end')}>
          <span
            className={overdue ? 'font-medium text-amber-700 dark:text-amber-400' : undefined}
            title={overdue ? t('sf_preview.project_end_past') : undefined}
          >
            {format(new Date(data.evalEndDate), 'MMM d, yyyy')}
          </span>
        </Row>
      )}
      {data.primaryEngineerName && (
        <Row icon={<UserCog className="h-3 w-3 shrink-0" />} label={t('sf_preview.primary_engineer')}>
          {data.primaryEngineerName}
        </Row>
      )}
    </div>
  )
}

function AccountBody({ data }: { data: SfPreviewData }) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const location = [data.city, data.country].filter(Boolean).join(', ')
  const anything = data.ownerName || data.industry || data.accountType || location || data.website
  if (!anything) {
    return <div className="py-2 italic text-gray-400 dark:text-gray-500">{t('sf_preview.account_no_details', { context: crmCtx })}</div>
  }
  return (
    <div className="space-y-0.5">
      {data.ownerName && (
        <Row icon={<User className="h-3 w-3 shrink-0" />} label={t('sf_preview.owner')}>{data.ownerName}</Row>
      )}
      {data.industry && (
        <Row icon={<Factory className="h-3 w-3 shrink-0" />} label={t('sf_preview.industry')}>{data.industry}</Row>
      )}
      {data.accountType && (
        <Row icon={<Building2 className="h-3 w-3 shrink-0" />} label={t('sf_preview.account_type')}>{data.accountType}</Row>
      )}
      {location && (
        <Row icon={<MapPin className="h-3 w-3 shrink-0" />} label={t('sf_preview.location')}>{location}</Row>
      )}
      {data.website && (
        <Row icon={<Globe className="h-3 w-3 shrink-0" />} label={t('sf_preview.website')}>
          <a
            href={/^https?:\/\//i.test(data.website) ? data.website : `https://${data.website}`}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-blue-600 hover:underline dark:text-blue-400"
          >
            {data.website}
          </a>
        </Row>
      )}
    </div>
  )
}
