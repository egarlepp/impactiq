import { useMemo, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Briefcase, Building2, CheckCircle2, CircleDashed, ExternalLink, Inbox, Lock, Megaphone, MessageCircleText, Sparkles, StickyNote, UserPlus } from 'lucide-react'
import { format } from 'date-fns'
import { Spinner } from '../ui/spinner.js'
import { SectionAccordion } from '../ui/section-accordion.js'
import { DynamicIcon } from '../ui/icon-picker.js'
import { cn } from '../../lib/utils.js'
import { formatRelativeTime } from '../../lib/time.js'
import { useOpportunityAccounts } from '../../hooks/useOpportunityAccounts.js'
import { AiNotesTab } from '../activities/AiNotesTab.js'
import type { AiNotesView, MyAiNoteRow } from '../../../shared/aiNotes.js'

// My Notes → AI (Gong plan, phase 5): the AI Notes on the caller's own
// activities, grouped like written notes (Opportunity / Account / Campaign /
// Lead, or Organize by Account). The right pane is the activity drawer's AI
// Notes tab itself, so Keep / Remove / Keep all / Copy to Notes behave the
// same in both places; the two views read one table.

type GroupKey = 'opportunity' | 'account' | 'campaign' | 'lead' | 'unlinked'

interface Group {
  key: GroupKey
  label: string
  icon: ComponentType<{ className?: string }>
  buckets: Map<string, { name: string; rows: MyAiNoteRow[] }>
}

export interface MyAiNotesPaneProps {
  rows: MyAiNoteRow[]
  loading: boolean
  selectedId: string | null
  onSelect: (activityId: string) => void
  viewMode: 'link_type' | 'by_account'
  dateSort: 'desc' | 'asc'
  nameSort: 'asc' | 'desc'
  expandTick: number
  collapseTick: number
  filtered: boolean
  // The open AI Note changed (kept, removed, regenerated): update its row.
  onRowChange: (activityId: string, view: AiNotesView) => void
  // A copy added a written note.
  onNotesChanged: () => void
}

function activityLabel(row: MyAiNoteRow, t: TFunction): string {
  if (row.activityIsPrivateMeeting) return t('activity.private_meeting.title')
  return row.activityTitle ?? t('my_notes.no_activity')
}

function linkName(row: MyAiNoteRow): string | null {
  return row.crmWhatName ?? row.crmWhoName ?? null
}

export function activityHref(row: MyAiNoteRow): string {
  const params = new URLSearchParams({ openActivityId: row.activityId })
  if (row.activityDate) params.set('startDate', format(new Date(row.activityDate), 'yyyy-MM-dd'))
  return `/?${params.toString()}`
}

function ReviewPill({ row, t }: { row: MyAiNoteRow; t: TFunction }) {
  if (row.toReview > 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
        <Inbox className="h-2.5 w-2.5" />
        {t('my_notes.ai.to_review_count', { count: row.toReview })}
      </span>
    )
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
      <CheckCircle2 className="h-2.5 w-2.5" />
      {t('my_notes.ai.reviewed')}
    </span>
  )
}

function AiListRow({ row, selected, onSelect, t }: { row: MyAiNoteRow; selected: boolean; onSelect: () => void; t: TFunction }) {
  const link = linkName(row)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-xs transition-colors',
        selected ? 'bg-blue-50 dark:bg-blue-950/30' : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60',
      )}
      style={selected && row.activityTypeColor ? { borderLeftColor: row.activityTypeColor } : undefined}
    >
      {row.activityTypeIcon ? (
        <DynamicIcon
          name={row.activityTypeIcon}
          className="h-3.5 w-3.5 shrink-0"
          {...(row.activityTypeColor ? { style: { color: row.activityTypeColor } } : {})}
        />
      ) : <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1 truncate font-medium text-gray-800 dark:text-gray-100">
          {row.activityIsPrivateMeeting ? <Lock className="h-3 w-3 shrink-0" /> : null}
          <span className="truncate">{activityLabel(row, t)}</span>
        </span>
        <span className="flex items-center gap-1 truncate text-[10px] text-gray-500 dark:text-gray-400">
          {link ? <><span className="truncate">{link}</span><span>·</span></> : null}
          <span title={new Date(row.generatedAt).toLocaleString()}>{formatRelativeTime(row.generatedAt, t)}</span>
          <span>·</span>
          {row.fromTranscript
            ? <span className="inline-flex items-center gap-0.5"><MessageCircleText className="h-2.5 w-2.5" />{t('my_notes.ai.from_call')}</span>
            : <span className="inline-flex items-center gap-0.5"><StickyNote className="h-2.5 w-2.5" />{t('my_notes.ai.notes_only')}</span>}
        </span>
      </div>
      <ReviewPill row={row} t={t} />
    </button>
  )
}

export function MyAiNotesPane(props: MyAiNotesPaneProps) {
  const { rows, loading, selectedId, onSelect, viewMode, dateSort, nameSort, expandTick, collapseTick, filtered, onRowChange, onNotesChanged } = props
  const { t, i18n } = useTranslation()

  const dateCmp = (a: MyAiNoteRow, z: MyAiNoteRow) => {
    const d = new Date(z.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    return dateSort === 'desc' ? d : -d
  }
  const nameCmp = (a: string, b: string) => (nameSort === 'asc' ? a.localeCompare(b) : b.localeCompare(a))

  const groups = useMemo<Group[]>(() => {
    const g: Record<GroupKey, Group> = {
      opportunity: { key: 'opportunity', label: t('my_notes.group_opportunities'), icon: Briefcase, buckets: new Map() },
      account: { key: 'account', label: t('my_notes.group_accounts'), icon: Building2, buckets: new Map() },
      campaign: { key: 'campaign', label: t('my_notes.group_campaigns'), icon: Megaphone, buckets: new Map() },
      lead: { key: 'lead', label: t('my_notes.group_leads'), icon: UserPlus, buckets: new Map() },
      unlinked: { key: 'unlinked', label: t('my_notes.group_unlinked'), icon: CircleDashed, buckets: new Map() },
    }
    for (const r of rows) {
      let key: GroupKey = 'unlinked'
      let id = 'none'
      let name = t('my_notes.group_unlinked')
      if (r.crmWhatId && (r.crmWhatType === 'Opportunity' || r.crmWhatType === 'Account' || r.crmWhatType === 'Campaign')) {
        key = r.crmWhatType === 'Opportunity' ? 'opportunity' : r.crmWhatType === 'Account' ? 'account' : 'campaign'
        id = r.crmWhatId
        name = r.crmWhatName ?? r.crmWhatId
      } else if (r.crmWhoType === 'Lead' && r.crmWhoId) {
        key = 'lead'
        id = r.crmWhoId
        name = r.crmWhoName ?? r.crmWhoId
      }
      const bucket = g[key].buckets.get(id) ?? { name, rows: [] }
      bucket.rows.push(r)
      g[key].buckets.set(id, bucket)
    }
    for (const group of Object.values(g)) for (const b of group.buckets.values()) b.rows.sort(dateCmp)
    return (['opportunity', 'account', 'campaign', 'lead', 'unlinked'] as GroupKey[]).map((k) => g[k])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, t, dateSort])

  const oppIds = useMemo(() => [...new Set(rows.filter((r) => r.crmWhatType === 'Opportunity' && r.crmWhatId).map((r) => r.crmWhatId as string))], [rows])
  const oppAccounts = useOpportunityAccounts(oppIds)

  const accountTree = useMemo(() => {
    interface OppSub { id: string; name: string; rows: MyAiNoteRow[] }
    interface AcctNode { id: string; name: string; direct: MyAiNoteRow[]; opps: Map<string, OppSub> }
    const roots = new Map<string, AcctNode>()
    const noAccount: MyAiNoteRow[] = []
    const root = (id: string, name: string) => {
      const r = roots.get(id) ?? { id, name, direct: [], opps: new Map<string, OppSub>() }
      roots.set(id, r)
      return r
    }
    for (const r of rows) {
      if (r.crmWhatType === 'Account' && r.crmWhatId) {
        root(r.crmWhatId, r.crmWhatName ?? r.crmWhatId).direct.push(r)
      } else if (r.crmWhatType === 'Opportunity' && r.crmWhatId) {
        const acct = oppAccounts.get(r.crmWhatId)
        const node = acct?.accountId
          ? root(acct.accountId, acct.accountName ?? acct.accountId)
          : root(`opp:${r.crmWhatId}`, r.crmWhatName ?? r.crmWhatId)
        const opp = node.opps.get(r.crmWhatId) ?? { id: r.crmWhatId, name: r.crmWhatName ?? r.crmWhatId, rows: [] }
        opp.rows.push(r)
        node.opps.set(r.crmWhatId, opp)
      } else {
        noAccount.push(r)
      }
    }
    for (const n of roots.values()) {
      n.direct.sort(dateCmp)
      for (const o of n.opps.values()) o.rows.sort(dateCmp)
    }
    noAccount.sort(dateCmp)
    return { accounts: [...roots.values()].sort((a, b) => nameCmp(a.name, b.name)), noAccount }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, oppAccounts, dateSort, nameSort])

  const selected = rows.find((r) => r.activityId === selectedId) ?? null
  const rowEl = (r: MyAiNoteRow) => (
    <AiListRow key={r.activityId} row={r} selected={r.activityId === selectedId} onSelect={() => onSelect(r.activityId)} t={t} />
  )
  const toReviewIn = (list: MyAiNoteRow[]) => list.reduce((s, r) => s + r.toReview, 0)
  const groupTitle = (label: string, list: MyAiNoteRow[]) => {
    const n = toReviewIn(list)
    return n > 0 ? `${label} · ${t('my_notes.ai.to_review_count', { count: n })}` : label
  }

  return (
    <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[320px_1fr]">
      <div className="flex min-h-0 flex-col overflow-y-auto rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {loading && rows.length === 0 ? <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div> : null}
        {!loading && rows.length === 0 ? (
          <p className="flex items-start gap-1.5 p-4 text-xs text-gray-400 dark:text-gray-500">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {filtered ? t('my_notes.ai.empty_filtered') : t('my_notes.ai.empty')}
          </p>
        ) : null}

        {rows.length > 0 && viewMode === 'link_type' && groups.map((g) => {
          const all = [...g.buckets.values()].flatMap((b) => b.rows)
          if (all.length === 0) return null
          const buckets = [...g.buckets.entries()]
          if (g.key !== 'unlinked') buckets.sort((a, b) => nameCmp(a[1].name, b[1].name))
          return (
            <SectionAccordion key={g.key} icon={g.icon} title={groupTitle(g.label, all)} count={all.length} defaultOpen expandAllTick={expandTick} collapseAllTick={collapseTick}>
              {buckets.map(([id, b]) => g.key === 'unlinked'
                ? <div key={id}>{b.rows.map(rowEl)}</div>
                : (
                  <SectionAccordion key={id} nested title={groupTitle(b.name, b.rows)} count={b.rows.length} defaultOpen expandAllTick={expandTick} collapseAllTick={collapseTick}>
                    {b.rows.map(rowEl)}
                  </SectionAccordion>
                ))}
            </SectionAccordion>
          )
        })}

        {rows.length > 0 && viewMode === 'by_account' && (
          <>
            {accountTree.accounts.map((a) => {
              const all = [...a.direct, ...[...a.opps.values()].flatMap((o) => o.rows)]
              const opps = [...a.opps.values()].sort((x, y) => nameCmp(x.name, y.name))
              return (
                <SectionAccordion key={a.id} icon={Building2} title={groupTitle(a.name, all)} count={all.length} defaultOpen={false} expandAllTick={expandTick} collapseAllTick={collapseTick}>
                  {a.direct.length > 0 ? (
                    <SectionAccordion nested title={t('my_notes.direct_account_notes')} count={a.direct.length} defaultOpen expandAllTick={expandTick} collapseAllTick={collapseTick}>
                      {a.direct.map(rowEl)}
                    </SectionAccordion>
                  ) : null}
                  {opps.map((o) => (
                    <SectionAccordion key={o.id} nested icon={Briefcase} title={groupTitle(o.name, o.rows)} count={o.rows.length} defaultOpen expandAllTick={expandTick} collapseAllTick={collapseTick}>
                      {o.rows.map(rowEl)}
                    </SectionAccordion>
                  ))}
                </SectionAccordion>
              )
            })}
            {accountTree.noAccount.length > 0 ? (
              <SectionAccordion icon={CircleDashed} title={groupTitle(t('my_notes.group_no_account'), accountTree.noAccount)} count={accountTree.noAccount.length} defaultOpen={false} expandAllTick={expandTick} collapseAllTick={collapseTick}>
                {accountTree.noAccount.map(rowEl)}
              </SectionAccordion>
            ) : null}
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {selected.activityTypeIcon ? (
                    <DynamicIcon
                      name={selected.activityTypeIcon}
                      className="h-4 w-4 shrink-0"
                      {...(selected.activityTypeColor ? { style: { color: selected.activityTypeColor } } : {})}
                    />
                  ) : <Sparkles className="h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-400" />}
                  <span className="truncate">{activityLabel(selected, t)}</span>
                </p>
                <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                  {[
                    selected.activityTypeName,
                    selected.activityDate ? new Date(selected.activityDate).toLocaleDateString(i18n.language, { dateStyle: 'medium' }) : null,
                    linkName(selected),
                  ].filter(Boolean).join(' · ')}
                </p>
              </div>
              <a
                href={activityHref(selected)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('my_notes.ai.open_activity')}
              </a>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <AiNotesTab
                activityId={selected.activityId}
                onViewChange={(v) => onRowChange(selected.activityId, v)}
                onNotesChanged={onNotesChanged}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center gap-1.5 p-8 text-sm text-gray-400 dark:text-gray-500">
            <Sparkles className="h-4 w-4" />
            {t('my_notes.ai.viewer_empty')}
          </div>
        )}
      </div>
    </div>
  )
}
