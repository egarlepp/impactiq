import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { CheckCircle2, CircleMinus, Ticket, ExternalLink, Building2, Search, Loader2 } from 'lucide-react'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Badge } from '../ui/badge.js'
import { Spinner } from '../ui/spinner.js'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { EvalFieldsPanel } from './EvalFieldsPanel.js'
import { useEvaluationSource } from '../../store/evaluationSource.js'
import { useCrmApiBase, useCrmLabelContext, useCrmProvider, useCrmRecordLinkBase } from '../../store/crmProvider.js'
import { CriteriaIqProjectPicker } from './CriteriaIqProjectPicker.js'

// v1.416.0: the per-type CRM Extras panels (Opp fields, related picker, tickets), moved unchanged out of ActivityForm.tsx.

export interface SfExtraConfig {
  apiName?: string
  label?: string
  fieldType?: 'boolean' | 'text' | 'number'
  mode?: 'read' | 'read_write'
  sobject?: string
  parentField?: string
  labelField?: string
  // v1.337.0: ticket_picker config — see admin's SfExtrasEditor.
  closedStatusValues?: string
}
export interface SfExtraRow {
  id: string
  kind: 'opp_field_display' | 'related_object_picker' | 'ticket_picker'
  config: SfExtraConfig
}

// v1.337.0: one attached ticket's denormalized snapshot — see
// drizzle/schema.ts activityCrmTickets for the storage this mirrors.
export interface TicketAttachment {
  crmTicketId: string
  crmTicketNumber: string
  crmSubject: string | null
  crmDateOpened: string | null
  crmStatus: string | null
  crmContact: string | null
  crmDescription: string | null
  crmPlatform: string | null
  crmOwner: string | null
}

// v1.67.0: fetches per-activity-type SF Extras once, shared by both
// SfExtrasPanel (opp_field_display / related_object_picker) and
// TicketExtrasPanel (ticket_picker) below — the two now mount in different
// places on the form (v1.337.1), so this hook keeps them from each firing
// their own GET /api/activities/sf-extras/:typeId.
export function useActivityTypeSfExtras(activityTypeId: string): { extras: SfExtraRow[]; fetchError: string | null } {
  const [extras, setExtras] = useState<SfExtraRow[]>([])
  const [fetchError, setFetchError] = useState<string | null>(null)
  useEffect(() => {
    if (!activityTypeId) { setExtras([]); setFetchError(null); return }
    let cancelled = false
    void (async () => {
      const res = await api.get<SfExtraRow[]>(`/api/activities/sf-extras/${activityTypeId}`)
      if (cancelled) return
      if (res.error) {
        console.warn('[sf-extras] fetch failed:', res.error)
        setFetchError(res.error)
        setExtras([])
      } else {
        setFetchError(null)
        setExtras(res.data ?? [])
      }
    })()
    return () => { cancelled = true }
  }, [activityTypeId])
  return { extras, fetchError }
}

// v1.67.0: renders the Opportunity-linked SF Extras (opp_field_display /
// related_object_picker) on the Activity form, directly under the SF Link
// section they describe — the child-object picker for whichever
// Opportunity was just linked above. Only mounts when an activity type is
// chosen. v1.337.1: ticket_picker moved to its own TicketExtrasPanel
// (rendered higher up the form, under Activity Type/Start-End Time) since
// it needs only an Account, never an Opportunity — this component now
// only ever deals with the two Opportunity-gated kinds.
export function SfExtrasPanel({
  teamId,
  activityTypeId,
  crmOppId,
  crmOppName,
  crmAccountId,
  relatedId,
  relatedName,
  onPickRelated,
  disabled,
}: {
  teamId: string
  activityTypeId: string
  crmOppId: string | null
  crmOppName: string | null
  crmAccountId: string | null
  relatedId: string | null
  relatedName: string | null
  onPickRelated: (sobject: string, id: string, name: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { extras, fetchError } = useActivityTypeSfExtras(activityTypeId)
  const otherExtras = extras.filter((x) => x.kind !== 'ticket_picker')
  // v1.388.0: with CriteriaIQ as the primary Project source, a Project picker
  // on this activity type picks a CriteriaIQ project instead of a Salesforce
  // record (CriteriaIqProjectPicker).
  const criteriaIqPrimary = useEvaluationSource().primary === 'criteriaiq'

  // Surface the error so admins can see when the endpoint is broken
  // (e.g. migration 0069 hasn't landed on this environment). Silent
  // when there's simply nothing configured.
  if (fetchError) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        {t('activity.form.sf_extras.load_failed', { error: fetchError })}
      </div>
    )
  }
  if (otherExtras.length === 0) return null
  if (!crmOppId) {
    return (
      <div className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-400">
        {t('activity.form.sf_extras.link_opp_first', { context: crmCtx })}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {otherExtras.map((x) => x.kind === 'opp_field_display'
        ? <OppFieldReadout key={x.id} oppId={crmOppId} cfg={x.config} />
        : criteriaIqPrimary
        ? <CriteriaIqProjectPicker
            key={x.id}
            label={x.config.label}
            oppId={crmOppId}
            oppName={crmOppName}
            accountId={crmAccountId}
            selectedId={relatedId}
            selectedName={relatedName}
            onPick={onPickRelated}
            disabled={disabled}
          />
        : <RelatedObjectPicker
            key={x.id}
            teamId={teamId}
            oppId={crmOppId}
            oppName={crmOppName}
            cfg={x.config}
            selectedId={relatedId}
            selectedName={relatedName}
            onPick={onPickRelated}
            disabled={disabled}
          />
      )}
    </div>
  )
}

// v1.337.1: renders the ticket_picker SF Extra(s) for the chosen activity
// type. Split out of SfExtrasPanel and mounted directly under Activity
// Type/Subtype + Start/End Time — a ticket picker only needs an Account
// (direct link, or an Opportunity's parent Account, both resolved into
// crmAccountId well before the SF Link field further down the form is even
// touched), never an Opportunity itself, so it doesn't belong gated behind
// the Opportunity-only empty state SfExtrasPanel shows. Renders nothing
// when the chosen activity type has no ticket_picker Extra configured.
export function TicketExtrasPanel({
  teamId,
  activityTypeId,
  crmAccountId,
  sfInstanceUrl,
  tickets,
  onTicketsChange,
  disabled,
  refreshing,
}: {
  teamId: string
  activityTypeId: string
  crmAccountId: string | null
  sfInstanceUrl: string | null
  tickets: TicketAttachment[]
  onTicketsChange: (tickets: TicketAttachment[]) => void
  disabled?: boolean
  refreshing?: boolean
}) {
  const { extras, fetchError } = useActivityTypeSfExtras(activityTypeId)
  if (fetchError) return null // SfExtrasPanel already surfaces this fetch error once
  const ticketExtras = extras.filter((x) => x.kind === 'ticket_picker')
  if (ticketExtras.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {ticketExtras.map((x) => (
        <TicketPicker
          key={x.id}
          teamId={teamId}
          sobject={x.config.sobject ?? ''}
          label={x.config.label}
          closedStatusValues={x.config.closedStatusValues}
          crmAccountId={crmAccountId}
          sfInstanceUrl={sfInstanceUrl}
          tickets={tickets}
          onChange={onTicketsChange}
          disabled={disabled}
          refreshing={refreshing}
        />
      ))}
    </div>
  )
}

// v1.293.0: one cell of the Total Bookings business breakdown (New Business /
// Renewals × ACV / TCV) — same "small uppercase label, mono value below"
// treatment as the Opp Amount (SF) box above it. `tip` carries the
// definition the user hovers to read, since these 4 abbreviations aren't
// self-explanatory.
export function BizNumberBox({ label, tip, value }: { label: string; tip: string; value: string | null }) {
  return (
    <div
      className="flex flex-col justify-center rounded border border-dashed border-gray-200 bg-white px-2 py-1 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-400"
      title={tip}
    >
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <span className="font-mono">{value != null ? Number(value).toLocaleString() : '—'}</span>
    </div>
  )
}

// An Activity Type's Opp field extra: one field on the linked Opportunity
// (Salesforce) or Deal property (HubSpot, config.sobject 'deals'), shown and,
// in read / write mode, edited in place. Both CRMs answer the same shapes.
export function OppFieldReadout({ oppId, cfg }: { oppId: string; cfg: SfExtraConfig }) {
  const { t } = useTranslation()
  const crmBase = useCrmApiBase()
  const onHubspot = useCrmProvider() === 'hubspot'
  const [state, setState] = useState<{ loading: boolean; value: unknown; label: string | null; options: Array<{ value: string; label: string }> | null; canEdit: boolean }>({ loading: true, value: null, label: null, options: null, canEdit: true })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    if (!cfg.apiName) return
    let cancelled = false
    void (async () => {
      const res = await api.get<{ value: unknown }>(`${crmBase}/opportunities/${encodeURIComponent(oppId)}/field?apiName=${encodeURIComponent(cfg.apiName!)}`)
      if (cancelled) return
      const meta = (res.meta ?? {}) as { label?: string | null; options?: Array<{ value: string; label: string }> | null; canEdit?: boolean }
      // canEdit (HubSpot only): false when the Deal edit rule on the HubSpot
      // card leaves this user read-only on this Deal.
      setState({ loading: false, value: res.data?.value ?? null, label: meta.label ?? null, options: meta.options ?? null, canEdit: meta.canEdit !== false })
    })()
    return () => { cancelled = true }
  }, [crmBase, oppId, cfg.apiName])
  const label = cfg.label ?? cfg.apiName ?? t('activity.form.opp_field.default_label')
  // fieldType may be missing on rows saved before v1.70.0 — infer from
  // the actual value coming back from the CRM so a boolean field
  // still renders as a checkbox even without an explicit fieldType.
  const inferredType: 'boolean' | 'number' | 'text' = cfg.fieldType
    ?? (typeof state.value === 'boolean' ? 'boolean'
      : typeof state.value === 'number' ? 'number'
      : 'text')
  // Editable only when admin set mode=read_write AND the extra targets the
  // CRM's Opportunity object (the only object either PATCH route writes).
  const writable = cfg.mode === 'read_write' && (cfg.sobject ?? 'Opportunity') === (onHubspot ? 'deals' : 'Opportunity') && state.canEdit

  async function persist(next: unknown) {
    if (!cfg.apiName) return
    setSaving(true); setSaveError(null)
    const res = await api.patch<{ ok: boolean }>(`${crmBase}/opportunities/${encodeURIComponent(oppId)}/field`, { apiName: cfg.apiName, value: next })
    setSaving(false)
    if (res.error) { setSaveError(res.error); return }
    setState((s) => ({ ...s, value: next, label: s.options?.find((o) => o.value === next)?.label ?? null }))
  }

  const shown = state.label ?? (state.value == null || state.value === '' ? null : String(state.value))
  return (
    <div className="flex flex-col gap-1 rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}:</span>
        {state.loading ? <Spinner className="h-3 w-3" /> : inferredType === 'boolean' ? (
          <input
            type="checkbox"
            checked={state.value === true || state.value === 'true'}
            onChange={(e) => writable && void persist(e.target.checked)}
            disabled={!writable || saving}
            className={writable ? 'h-4 w-4 cursor-pointer' : 'h-4 w-4 cursor-not-allowed'}
          />
        ) : writable && state.options && state.options.length > 0 ? (
          <select
            value={state.value == null ? '' : String(state.value)}
            onChange={(e) => void persist(e.target.value === '' ? null : e.target.value)}
            disabled={saving}
            className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">{t('activity.form.related_picker.none_option')}</option>
            {state.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : writable ? (
          <input
            type={inferredType === 'number' ? 'number' : 'text'}
            defaultValue={state.value == null ? '' : String(state.value)}
            onBlur={(e) => {
              const raw = e.target.value
              const next = inferredType === 'number' ? (raw === '' ? null : Number(raw)) : raw
              if (next !== state.value) void persist(next)
            }}
            disabled={saving}
            className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        ) : (
          <span className="text-xs text-gray-900 dark:text-gray-100">{shown ?? '—'}</span>
        )}
        {saving && <Spinner className="h-3 w-3" />}
        <span className="ml-auto rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400" title={writable ? t('activity.form.opp_field.editable_tip') : t('activity.form.opp_field.readonly_tip')}>
          {cfg.apiName}
        </span>
      </div>
      {saveError && <p className="text-[10px] text-red-600 dark:text-red-400">{saveError}</p>}
    </div>
  )
}

export function RelatedObjectPicker({ teamId, oppId, oppName, cfg, selectedId, selectedName, onPick, disabled }: {
  teamId: string
  oppId: string; oppName: string | null; cfg: SfExtraConfig
  selectedId: string | null; selectedName: string | null
  onPick: (sobject: string, id: string, name: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const crmBase = useCrmApiBase()
  const onHubspot = useCrmProvider() === 'hubspot'
  const [rows, setRows] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!cfg.sobject) return
    let cancelled = false
    void (async () => {
      const params = new URLSearchParams({
        sobject: cfg.sobject!,
        parentField: cfg.parentField ?? 'Opportunity__c',
        labelField: cfg.labelField ?? 'Name',
      })
      const res = await api.get<Array<{ id: string; name: string }>>(`${crmBase}/opportunities/${encodeURIComponent(oppId)}/related?${params.toString()}`)
      if (!cancelled) { setRows(res.data ?? []); setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [crmBase, oppId, cfg.sobject, cfg.parentField, cfg.labelField])
  const label = cfg.label ?? (onHubspot ? t('activity.form.related_picker.default_label_hubspot') : cfg.sobject) ?? t('activity.form.related_picker.default_label')
  return (
    <div className="flex flex-col gap-1 rounded-md border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</span>
        {/* A HubSpot object type id (0-970, 2-…) means nothing to a reader. */}
        {!onHubspot && <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{cfg.sobject}</span>}
        {loading && <Spinner className="ml-1 h-3 w-3" />}
      </div>
      {rows.length === 0 && !loading ? (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('activity.form.related_picker.no_records', { context: onHubspot ? 'hubspot' : undefined })}</p>
      ) : (
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            const id = e.target.value
            const row = rows.find((r) => r.id === id)
            if (id && row) onPick(cfg.sobject!, row.id, row.name)
            else onPick(cfg.sobject!, '', '')
          }}
          disabled={disabled}
          className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="">{t('activity.form.related_picker.none_option')}</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      )}
      {selectedId && selectedName && cfg.sobject && (
        // v1.149.0: EvalFieldsPanel is object-agnostic — it degrades to a
        // plain "Linked: X" line when the picked object has no eval field
        // mappings, so non-Evaluation related pickers behave as before.
        <EvalFieldsPanel teamId={teamId} sobject={cfg.sobject} relatedId={selectedId} relatedName={selectedName} oppId={oppId} oppName={oppName} disabled={disabled} />
      )}
    </div>
  )
}

export interface SfTicketSearchRow {
  id: string
  ticketNumber: string
  subject: string | null
  dateOpened: string | null
  status: string | null
  contact: string | null
  description: string | null
  platform: string | null
  owner: string | null
}

// v1.337.0: multi-attach Salesforce ticket picker, powering the
// 'ticket_picker' Extra (CLAUDE.md §7). Always defaults to the connected
// Account's tickets (Building2 toggle) with a permanently-available Open
// Search toggle (Search icon) for tickets outside that Account — per the
// locked-in "Open Search always available as a toggle" decision, not a
// mode that only appears once no Account is linked. Attached tickets are
// stored as a denormalized snapshot (see TicketAttachment) — clicking a
// result attaches/detaches it locally; the parent only persists the
// snapshot on Save, same as every other Extra on this form.
export function TicketPicker({
  teamId,
  sobject,
  label,
  closedStatusValues,
  crmAccountId,
  sfInstanceUrl,
  tickets,
  onChange,
  disabled,
  refreshing,
}: {
  teamId: string
  sobject: string
  label?: string
  closedStatusValues?: string
  crmAccountId: string | null
  sfInstanceUrl: string | null
  tickets: TicketAttachment[]
  onChange: (tickets: TicketAttachment[]) => void
  disabled?: boolean
  refreshing?: boolean
}) {
  const { t } = useTranslation()
  // HubSpot (phase 4): every portal has the same ticket object, so no
  // sobject or closed-status config is needed; closed means a closed
  // pipeline stage, decided server-side.
  const onHubspot = useCrmProvider() === 'hubspot'
  const crmCtx = useCrmLabelContext()
  const hubspotLinkBase = useCrmRecordLinkBase()
  const ticketHref = (id: string): string | null => onHubspot
    ? (hubspotLinkBase ? `${hubspotLinkBase}/0-5/${encodeURIComponent(id)}` : null)
    : (sfInstanceUrl ? `${sfInstanceUrl}/${id}` : null)
  const [mode, setMode] = useState<'account' | 'open'>('account')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SfTicketSearchRow[]>([])
  const [loading, setLoading] = useState(false)
  const [includeClosed, setIncludeClosed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    if (mode === 'account' && !crmAccountId) setMode('open')
  }, [mode, crmAccountId])

  useEffect(() => {
    if ((!sobject && !onHubspot) || !searchOpen) return
    if (mode === 'account' && !crmAccountId) { setResults([]); return }
    if (mode === 'open' && query.trim().length < 2) { setResults([]); return }
    let cancelled = false
    setLoading(true)
    const handle = setTimeout(() => {
      const params = new URLSearchParams(onHubspot ? { teamId } : { teamId, sobject })
      if (mode === 'account' && crmAccountId) params.set('accountId', crmAccountId)
      if (mode === 'open' && query.trim()) params.set('q', query.trim())
      if (includeClosed) params.set('includeClosed', 'true')
      if (closedStatusValues && !onHubspot) params.set('closedStatusValues', closedStatusValues)
      const base = onHubspot ? '/api/crm' : '/api/salesforce'
      void api.get<SfTicketSearchRow[]>(`${base}/tickets/search?${params.toString()}`).then((res) => {
        if (cancelled) return
        setResults(res.data ?? [])
        setLoading(false)
      })
    }, 300)
    return () => { cancelled = true; clearTimeout(handle) }
  }, [teamId, sobject, mode, crmAccountId, query, includeClosed, closedStatusValues, searchOpen, onHubspot])

  if (!sobject && !onHubspot) return null

  function toggleAttach(row: SfTicketSearchRow) {
    const already = tickets.some((tk) => tk.crmTicketId === row.id)
    if (already) {
      onChange(tickets.filter((tk) => tk.crmTicketId !== row.id))
      return
    }
    onChange([...tickets, {
      crmTicketId: row.id,
      crmTicketNumber: row.ticketNumber,
      crmSubject: row.subject,
      crmDateOpened: row.dateOpened,
      crmStatus: row.status,
      crmContact: row.contact,
      crmDescription: row.description,
      crmPlatform: row.platform,
      crmOwner: row.owner,
    }])
  }
  function detach(crmTicketId: string) {
    onChange(tickets.filter((tk) => tk.crmTicketId !== crmTicketId))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="inline-flex items-center gap-1.5">
        <Ticket className="h-3.5 w-3.5" />
        {label || t('activity.form.tickets_label', 'Support Tickets')}
        <span className="text-[10px] font-normal text-gray-400">{t('common.optional', 'optional')}</span>
        {refreshing && tickets.length > 0 && (
          <span
            title={t('activity.form.tickets_refreshing', { context: crmCtx })}
            aria-label={t('activity.form.tickets_refreshing', { context: crmCtx })}
            className="inline-flex shrink-0"
          >
            <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
          </span>
        )}
      </Label>

      {tickets.length > 0 && (
        <ul className="flex flex-col gap-1">
          {tickets.map((tk) => (
            <li key={tk.crmTicketId} className="flex items-center justify-between gap-2 rounded border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => detach(tk.crmTicketId)}
                    className="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-400"
                    title={t('activity.form.tickets_remove', 'Remove ticket')}
                    aria-label={t('activity.form.tickets_remove', 'Remove ticket')}
                  >
                    <CircleMinus className="h-3.5 w-3.5" />
                  </button>
                )}
                {ticketHref(tk.crmTicketId) ? (
                  <a
                    href={ticketHref(tk.crmTicketId) ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-0.5 font-mono font-semibold text-blue-600 hover:underline dark:text-blue-400"
                    title={t('activity.form.tickets_open_in_sf', { context: crmCtx })}
                  >
                    {tk.crmTicketNumber}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="shrink-0 font-mono font-semibold text-gray-700 dark:text-gray-200">{tk.crmTicketNumber}</span>
                )}
                <span
                  className="truncate text-gray-600 dark:text-gray-300"
                  title={[tk.crmDescription, tk.crmPlatform, tk.crmOwner].filter(Boolean).join(' · ') || undefined}
                >
                  {tk.crmSubject ?? '—'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
                {tk.crmStatus && <Badge variant="outline" className="text-[10px]">{tk.crmStatus}</Badge>}
                {tk.crmContact && <span>{tk.crmContact}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <div className="flex shrink-0 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => setMode('account')}
                aria-pressed={mode === 'account'}
                disabled={!crmAccountId}
                title={t('activity.form.tickets_toggle_account', { context: crmCtx })}
                aria-label={t('activity.form.tickets_toggle_account', { context: crmCtx })}
                className={cn(
                  'flex h-7 w-8 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  mode === 'account'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
              >
                <Building2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setMode('open')}
                aria-pressed={mode === 'open'}
                title={t('activity.form.tickets_toggle_open', 'Open Search — all tickets')}
                aria-label={t('activity.form.tickets_toggle_open', 'Open Search — all tickets')}
                className={cn(
                  'flex h-7 w-8 items-center justify-center transition-colors',
                  mode === 'open'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700',
                )}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </div>
            <button type="button" onClick={() => setSearchOpen((o) => !o)} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
              {searchOpen
                ? t('activity.form.tickets_hide_search', 'Hide ticket search')
                : mode === 'account'
                  ? t('activity.form.tickets_search_account', { context: crmCtx })
                  : t('activity.form.tickets_search_open', 'Search all tickets')}
            </button>
          </div>

          {searchOpen && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800/40">
              {mode === 'open' && (
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('activity.form.tickets_search_placeholder', 'Search by ticket number or subject…')}
                  className="mb-2 h-7 text-xs"
                />
              )}
              <label className="mb-2 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
                {t('activity.form.tickets_show_closed', 'Show Closed')}
              </label>
              {loading ? (
                <Spinner className="h-4 w-4" />
              ) : results.length === 0 ? (
                <p className="text-[11px] text-gray-400">
                  {mode === 'account' && !crmAccountId
                    ? t('activity.form.tickets_no_account', { context: crmCtx })
                    : mode === 'open' && query.trim().length < 2
                      ? t('activity.form.tickets_type_to_search', 'Type at least 2 characters to search.')
                      : t('activity.form.tickets_no_results', 'No tickets found.')}
                </p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                  {results.map((row) => {
                    const attached = tickets.some((tk) => tk.crmTicketId === row.id)
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => toggleAttach(row)}
                          title={[row.description, row.platform, row.owner].filter(Boolean).join(' · ') || undefined}
                          className={cn(
                            'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs hover:bg-white dark:hover:bg-gray-900',
                            attached && 'bg-blue-50 dark:bg-blue-950/40',
                          )}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="shrink-0 font-mono font-semibold text-gray-700 dark:text-gray-200">{row.ticketNumber}</span>
                            <span className="truncate text-gray-600 dark:text-gray-300">{row.subject ?? '—'}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-[10px] text-gray-400">
                            {row.dateOpened && <span>{format(new Date(row.dateOpened), 'MM/dd/yy')}</span>}
                            {row.status && <Badge variant="outline" className="text-[10px]">{row.status}</Badge>}
                            {row.contact && <span>{row.contact}</span>}
                            {attached && <CheckCircle2 className="h-3 w-3 text-blue-600 dark:text-blue-400" />}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
