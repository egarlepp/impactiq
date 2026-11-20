import { useEffect, useMemo, useState, useCallback, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { NotebookPen, Send, Pencil, Trash2, Check, X, CheckCircle2, AlertCircle, Loader2, Sparkles, MessageSquare, Link as LinkIcon, Search, Briefcase, Building2, Megaphone, UserPlus, CircleDashed, Copy, Group, CalendarArrowDown, CalendarArrowUp, ArrowDownAZ, ArrowDownZA, List, FileText, Expand, Minimize, Users, Lock, LockOpen, UserLock, Inbox } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PageHeader } from '../components/ui/page-header.js'
import { Input } from '../components/ui/input.js'
import { Button } from '../components/ui/button.js'
import { Textarea } from '../components/ui/textarea.js'
import { Spinner } from '../components/ui/spinner.js'
import { Badge } from '../components/ui/badge.js'
import { Dialog } from '../components/ui/dialog.js'
import { SectionAccordion } from '../components/ui/section-accordion.js'
import { DynamicIcon } from '../components/ui/icon-picker.js'
import { MarkdownHelpPopover } from '../components/ui/markdown-help.js'
import { cn } from '../lib/utils.js'
import { api } from '../lib/api.js'
import type { AiFeature } from '../../shared/ai.js'
import { formatRelativeTime } from '../lib/time.js'
import { sfIcon } from '../lib/sf-icons.js'
import { useOpportunityAccounts } from '../hooks/useOpportunityAccounts.js'
import { useCrmProjects } from '../store/evaluationSource.js'
import { useCrmLabelContext, crmApiBase } from '../store/crmProvider.js'
import { MyAiNotesPane } from '../components/aiNotes/MyAiNotesPane.js'
import type { AiNotesView, MyAiNotesList } from '../../shared/aiNotes.js'

type MeddpiccKey = 'metrics' | 'economic_buyer' | 'decision_criteria' | 'decision_process' | 'paper_process' | 'identified_pain' | 'champion' | 'competition'
type MeddpiccMap = Partial<Record<MeddpiccKey, string[]>>

const MEDDPICC_KEYS: MeddpiccKey[] = ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'paper_process', 'identified_pain', 'champion', 'competition']
// Fixed first letter per field (the MEDDPICC acronym) — not locale-derived, so
// the list-row badges always read M/E/D/D/P/I/C/C regardless of language.
const MEDDPICC_LETTER: Record<MeddpiccKey, string> = {
  metrics: 'M', economic_buyer: 'E', decision_criteria: 'D', decision_process: 'D',
  paper_process: 'P', identified_pain: 'I', champion: 'C', competition: 'C',
}

interface PushRow {
  id: string
  crmTargetType: string
  crmTargetId: string
  crmTargetName: string | null
  crmContentNoteId: string | null
  status: 'pending' | 'synced' | 'failed' | string
  error: string | null
  createdAt: string
  syncedAt: string | null
}

// A retried push creates a NEW row rather than overwriting the failed one
// (see enqueuePush's dedupe rule in notesPush.ts), so a note's full push
// history can hold a stale failed attempt alongside the successful retry
// that superseded it. Status badges should reflect only the most recent
// attempt per (type, target) pair.
function latestPushesByTarget(pushes: PushRow[]): PushRow[] {
  const byTarget = new Map<string, PushRow>()
  for (const p of pushes) {
    const key = `${p.crmTargetType}:${p.crmTargetId}`
    const existing = byTarget.get(key)
    if (!existing || new Date(p.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      byTarget.set(key, p)
    }
  }
  return Array.from(byTarget.values())
}

interface NoteRow {
  id: string
  activityId: string
  teamId: string | null
  activityTitle: string | null
  // v1.262.0: whether the underlying meeting is Private/Confidential in
  // Outlook — masks activityTitle to "Private meeting" everywhere it's
  // shown. Unrelated to `isPrivate` below (the note's own visibility).
  // See CLAUDE.md §7 Private Meetings.
  activityIsPrivateMeeting?: boolean
  activityDate: string | null
  activityTypeName: string | null
  activityTypeColor: string | null
  activityTypeIcon: string | null
  crmWhatId: string | null
  crmWhatType: string | null
  crmWhatName: string | null
  crmWhoId: string | null
  crmWhoType: string | null
  crmWhoName: string | null
  crmRelatedType: string | null
  crmRelatedId: string | null
  body: string
  meddpicc: MeddpiccMap
  isPrivate: boolean
  createdAt: string
  updatedAt: string
  createdBy: { userId: string | null; displayName: string | null; firstName: string | null; lastName: string | null }
  canEdit: boolean
  pushes: PushRow[]
}

type LinkGroupKey = 'opportunity' | 'account' | 'campaign' | 'lead' | 'unlinked'

interface LinkGroup {
  key: LinkGroupKey
  label: string
  icon: ComponentType<{ className?: string }>
  buckets: Map<string, { name: string; notes: NoteRow[] }>
}

export default function MyNotes() {
  const { t } = useTranslation()
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pushTarget, setPushTarget] = useState<{ noteIds: string[] } | null>(null)
  // Which AI features can run (Admin → AI Assistant switches, provider,
  // budget). Unknown until loaded, and then every AI action stays shown.
  const [aiFeatures, setAiFeatures] = useState<Partial<Record<AiFeature, boolean>>>({})
  useEffect(() => {
    let cancelled = false
    void api.get<Record<AiFeature, boolean>>('/api/ai/features').then((res) => {
      if (!cancelled && res.data) setAiFeatures(res.data)
    })
    return () => { cancelled = true }
  }, [])
  // Layout / sort preferences. All three persist to localStorage so
  // the SE doesn't reset them on every navigation.
  const [viewMode, setViewMode] = useState<'link_type' | 'by_account'>(() => {
    try { return (localStorage.getItem('my_notes.viewMode') as 'link_type' | 'by_account') || 'link_type' } catch { return 'link_type' }
  })
  const [dateSort, setDateSort] = useState<'desc' | 'asc'>(() => {
    try { return (localStorage.getItem('my_notes.dateSort') as 'desc' | 'asc') || 'desc' } catch { return 'desc' }
  })
  const [nameSort, setNameSort] = useState<'asc' | 'desc'>(() => {
    try { return (localStorage.getItem('my_notes.nameSort') as 'asc' | 'desc') || 'asc' } catch { return 'asc' }
  })
  // v1.127.0: "Show all users' notes" toggle. Persisted to localStorage
  // so the SE doesn't have to re-enable it every session. When on, the
  // note list widens to every note on activities the caller has team
  // access to (see server-side scope=mine&allUsers=1), and grouping
  // inserts an owner-lastname bucket below the SF object node.
  const [allUsers, setAllUsers] = useState<boolean>(() => {
    try { return localStorage.getItem('my_notes.allUsers') === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('my_notes.viewMode', viewMode) } catch { /* ignore */ } }, [viewMode])
  useEffect(() => { try { localStorage.setItem('my_notes.dateSort', dateSort) } catch { /* ignore */ } }, [dateSort])
  useEffect(() => { try { localStorage.setItem('my_notes.nameSort', nameSort) } catch { /* ignore */ } }, [nameSort])
  useEffect(() => { try { localStorage.setItem('my_notes.allUsers', allUsers ? '1' : '0') } catch { /* ignore */ } }, [allUsers])
  // Tick counters that propagate down to every SectionAccordion so
  // Expand All / Collapse All buttons can force all rows open/closed
  // without lifting each accordion's state into this component.
  const [expandTick, setExpandTick] = useState(0)
  const [collapseTick, setCollapseTick] = useState(0)
  // v1.458.0 (Gong plan, phase 5): Written / AI switch. The AI side lists
  // the AI Notes on the caller's own activities; the two are never mixed.
  const [source, setSource] = useState<'written' | 'ai'>(() => {
    try { return localStorage.getItem('my_notes.source') === 'ai' ? 'ai' : 'written' } catch { return 'written' }
  })
  const [aiReviewOnly, setAiReviewOnly] = useState<boolean>(() => {
    try { return localStorage.getItem('my_notes.aiReviewOnly') === '1' } catch { return false }
  })
  const [aiList, setAiList] = useState<MyAiNotesList | null>(null)
  const [aiLoading, setAiLoading] = useState(true)
  const [aiSelectedId, setAiSelectedId] = useState<string | null>(null)
  useEffect(() => { try { localStorage.setItem('my_notes.source', source) } catch { /* ignore */ } }, [source])
  useEffect(() => { try { localStorage.setItem('my_notes.aiReviewOnly', aiReviewOnly ? '1' : '0') } catch { /* ignore */ } }, [aiReviewOnly])

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(h)
  }, [q])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ scope: 'mine' })
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
    if (allUsers) params.set('allUsers', '1')
    const res = await api.get<NoteRow[]>(`/api/notes?${params.toString()}`)
    if (res.error) setError(res.error)
    else {
      setNotes(res.data ?? [])
      // Preserve selection if it's still in the list; otherwise pick the first.
      const first = (res.data ?? [])[0]?.id ?? null
      setSelectedId((prev) => {
        if (prev && (res.data ?? []).some((n) => n.id === prev)) return prev
        return first
      })
    }
    setLoading(false)
  }, [debouncedQ, allUsers])

  useEffect(() => { void load() }, [load])

  // The AI list loads with the written one (same search) so the switch can
  // show both counts. A stale response for an older search is dropped.
  useEffect(() => {
    let cancelled = false
    setAiLoading(true)
    const params = new URLSearchParams()
    if (debouncedQ.trim()) params.set('q', debouncedQ.trim())
    void api.get<MyAiNotesList>(`/api/ai-notes/mine?${params.toString()}`).then((res) => {
      if (cancelled) return
      setAiLoading(false)
      if (res.error || !res.data) { setAiList(null); return }
      const list = res.data
      setAiList(list)
      setAiSelectedId((prev) => (prev && list.notes.some((n) => n.activityId === prev) ? prev : list.notes[0]?.activityId ?? null))
    })
    return () => { cancelled = true }
  }, [debouncedQ])

  const aiEnabled = !!aiList?.enabled
  const showAi = source === 'ai' && aiEnabled
  const aiRows = useMemo(() => {
    const all = aiList?.notes ?? []
    // Keep the open one in the list while its last items are being kept.
    return aiReviewOnly ? all.filter((n) => n.toReview > 0 || n.activityId === aiSelectedId) : all
  }, [aiList, aiReviewOnly, aiSelectedId])

  const onAiRowChange = useCallback((activityId: string, view: AiNotesView) => {
    setAiList((prev) => {
      if (!prev) return prev
      const toReview = view.items.filter((i) => i.status === 'to_review').length
      const kept = view.items.length - toReview
      const notes = prev.notes.map((n) => n.activityId === activityId
        ? { ...n, toReview, kept, generatedAt: view.note?.generatedAt ?? n.generatedAt, fromTranscript: view.note?.fromTranscript ?? n.fromTranscript }
        : n)
      return { ...prev, notes, totals: { notes: notes.length, toReview: notes.reduce((s, n) => s + n.toReview, 0) } }
    })
  }, [])

  // Live-poll while any push is pending so the chip flips to Pushed
  // without a manual reload.
  useEffect(() => {
    const anyPending = notes.some((n) => n.pushes.some((p) => p.status === 'pending'))
    if (!anyPending) return
    const h = setInterval(() => { void load() }, 5000)
    return () => clearInterval(h)
  }, [notes, load])

  // Collect the set of Opp ids present so we can resolve each Opp
  // to its parent Account and enable Organize-by-Account.
  const oppIds = useMemo(() => Array.from(new Set(notes.filter((n) => n.crmWhatType === 'Opportunity' && n.crmWhatId).map((n) => n.crmWhatId as string))), [notes])
  const oppAccounts = useOpportunityAccounts(oppIds)

  const dateCmp = (a: NoteRow, z: NoteRow) => {
    const d = new Date(z.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    return dateSort === 'desc' ? d : -d
  }
  const nameCmp = (a: string, b: string) => {
    const c = a.localeCompare(b)
    return nameSort === 'asc' ? c : -c
  }

  // Two layouts. link_type keeps today's five-group taxonomy. by_account
  // rolls Opportunities up under their parent Account (via
  // useOpportunityAccounts) and shows Direct-Account notes alongside.
  // Leads and Campaigns stay in their own groups at the bottom of
  // by_account view since neither has a first-class Account column.
  const groups = useMemo<LinkGroup[]>(() => {
    const g: Record<LinkGroupKey, LinkGroup> = {
      opportunity: { key: 'opportunity', label: t('my_notes.group_opportunities', 'Opportunities'), icon: Briefcase, buckets: new Map() },
      account: { key: 'account', label: t('my_notes.group_accounts', 'Accounts'), icon: Building2, buckets: new Map() },
      campaign: { key: 'campaign', label: t('my_notes.group_campaigns', 'Campaigns'), icon: Megaphone, buckets: new Map() },
      lead: { key: 'lead', label: t('my_notes.group_leads', 'Leads'), icon: UserPlus, buckets: new Map() },
      unlinked: { key: 'unlinked', label: t('my_notes.group_unlinked', 'Not linked'), icon: CircleDashed, buckets: new Map() },
    }
    for (const n of notes) {
      let key: LinkGroupKey
      let bucketId: string
      let bucketName: string
      if (n.crmWhatType === 'Opportunity' && n.crmWhatId) { key = 'opportunity'; bucketId = n.crmWhatId; bucketName = n.crmWhatName ?? n.crmWhatId }
      else if (n.crmWhatType === 'Account' && n.crmWhatId) { key = 'account'; bucketId = n.crmWhatId; bucketName = n.crmWhatName ?? n.crmWhatId }
      else if (n.crmWhatType === 'Campaign' && n.crmWhatId) { key = 'campaign'; bucketId = n.crmWhatId; bucketName = n.crmWhatName ?? n.crmWhatId }
      else if (n.crmWhoType === 'Lead' && n.crmWhoId) { key = 'lead'; bucketId = n.crmWhoId; bucketName = n.crmWhoName ?? n.crmWhoId }
      else { key = 'unlinked'; bucketId = 'none'; bucketName = t('my_notes.group_unlinked', 'Not linked') }
      const bucket = g[key].buckets.get(bucketId) ?? { name: bucketName, notes: [] }
      bucket.notes.push(n)
      g[key].buckets.set(bucketId, bucket)
    }
    // Sort each bucket's notes. When the "show all users" toggle is on,
    // primary-sort by owner last name (so peers cluster together) and
    // secondary-sort by date; otherwise date only.
    for (const key of Object.keys(g) as LinkGroupKey[]) {
      for (const b of g[key].buckets.values()) {
        if (allUsers) {
          b.notes.sort((a, z) => {
            const al = (a.createdBy.lastName ?? a.createdBy.displayName ?? '').toLowerCase()
            const zl = (z.createdBy.lastName ?? z.createdBy.displayName ?? '').toLowerCase()
            if (al !== zl) return al < zl ? -1 : 1
            return dateCmp(a, z)
          })
        } else {
          b.notes.sort(dateCmp)
        }
      }
    }
    return (['opportunity', 'account', 'campaign', 'lead', 'unlinked'] as LinkGroupKey[]).map((k) => g[k])
  }, [notes, t, dateSort, allUsers])

  // Alt layout: one top-level bucket per Account, with nested Opps.
  interface OppSub { id: string; name: string; notes: NoteRow[] }
  interface AcctNode { accountId: string; accountName: string; direct: NoteRow[]; opps: Map<string, OppSub> }
  const accountTree = useMemo(() => {
    const roots = new Map<string, AcctNode>()
    const noAccount: NoteRow[] = []
    const newAcct = (accountId: string, accountName: string): AcctNode => ({ accountId, accountName, direct: [], opps: new Map<string, OppSub>() })
    const newOpp = (id: string, name: string): OppSub => ({ id, name, notes: [] })
    for (const n of notes) {
      if (n.crmWhatType === 'Account' && n.crmWhatId) {
        const key = n.crmWhatId
        const r = roots.get(key) ?? newAcct(key, n.crmWhatName ?? key)
        r.direct.push(n)
        roots.set(key, r)
      } else if (n.crmWhatType === 'Opportunity' && n.crmWhatId) {
        const oppId = n.crmWhatId
        const resolved = oppAccounts.get(oppId)
        if (resolved && resolved.accountId) {
          const key = resolved.accountId
          const r = roots.get(key) ?? newAcct(key, resolved.accountName ?? key)
          const opp = r.opps.get(oppId) ?? newOpp(oppId, n.crmWhatName ?? oppId)
          opp.notes.push(n)
          r.opps.set(oppId, opp)
          roots.set(key, r)
        } else {
          // Account not resolved yet — the hook returns an empty map
          // until the first response lands. Place under a placeholder
          // bucket keyed by the Opp so it still shows.
          const placeholder = `opp:${oppId}`
          const r = roots.get(placeholder) ?? newAcct(placeholder, n.crmWhatName ?? '(loading Account…)')
          const opp = r.opps.get(oppId) ?? newOpp(oppId, n.crmWhatName ?? oppId)
          opp.notes.push(n)
          r.opps.set(oppId, opp)
          roots.set(placeholder, r)
        }
      } else {
        noAccount.push(n)
      }
    }
    // Sort notes within each container by dateSort.
    for (const r of roots.values()) {
      r.direct.sort(dateCmp)
      for (const o of r.opps.values()) o.notes.sort(dateCmp)
    }
    noAccount.sort(dateCmp)
    // Sort account order by name.
    const ordered = Array.from(roots.values()).sort((a, b) => nameCmp(a.accountName, b.accountName))
    return { accounts: ordered, noAccount }
  }, [notes, oppAccounts, dateSort, nameSort])

  const selected = notes.find((n) => n.id === selectedId) ?? null

  const patchNote = useCallback((updated: Partial<NoteRow> & { id: string }) => {
    setNotes((prev) => prev.map((n) => n.id === updated.id ? { ...n, ...updated } : n))
  }, [])

  const removeNote = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    setSelectedId((prev) => (prev === id ? null : prev))
  }, [])

  return (
    // Match Settings / Dashboard: outer has NO padding so the
    // PageHeader sits flush with the top nav edge. Inner content
    // owns its own padding so the header bar looks consistent
    // across pages.
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={NotebookPen}
        title={t('my_notes.title', 'My Notes')}
        subtitle={t('my_notes.subtitle_v2', 'Split-pane explorer. Pick a note on the left to review, edit, tag with MEDDPICC, or run through AI.')}
      />

      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-2">
        {aiEnabled && (
          <div className="inline-flex rounded-md border border-gray-200 p-0.5 dark:border-gray-700" role="group" aria-label={t('my_notes.ai.switch_aria')}>
            {(['written', 'ai'] as const).map((key) => {
              const on = (key === 'ai') === showAi
              const Icon = key === 'ai' ? Sparkles : NotebookPen
              const label = key === 'ai'
                ? (aiList && aiList.totals.toReview > 0
                  ? t('my_notes.ai.switch_ai_review', { count: aiList.totals.notes, review: aiList.totals.toReview })
                  : t('my_notes.ai.switch_ai', { count: aiList?.totals.notes ?? 0 }))
                : t('my_notes.ai.switch_written', { count: notes.length })
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSource(key)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                    on
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              )
            })}
          </div>
        )}
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={showAi ? t('my_notes.ai.search_placeholder') : t('my_notes.search_placeholder_v2', 'Search notes, Opp / Account / Campaign / Lead…')}
            className="pl-7"
          />
        </div>
        {/* Icon-button row — packed tight, no gap between siblings. */}
        <div className="inline-flex items-center gap-0">
          {/* v1.127.0: show all users' notes. Widens the query to every
              note on activities the caller has team access to (server
              still filters out private notes not owned by the caller
              unless the caller is App Admin). */}
          {showAi ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAiReviewOnly((v) => !v)}
              className={aiReviewOnly ? 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/50 dark:text-blue-200 dark:hover:bg-blue-900/50' : undefined}
              aria-pressed={aiReviewOnly}
              title={aiReviewOnly ? t('my_notes.ai.review_only_off') : t('my_notes.ai.review_only_on')}
              aria-label={t('my_notes.ai.review_only_aria')}
            >
              <Inbox className="h-3.5 w-3.5" />
            </Button>
          ) : (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAllUsers((v) => !v)}
            className={allUsers ? 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/50 dark:text-blue-200 dark:hover:bg-blue-900/50' : undefined}
            aria-pressed={allUsers}
            title={allUsers
              ? t('my_notes.all_users_off', 'Showing every teammate\'s notes — click to see only yours')
              : t('my_notes.all_users_on', 'Show all teammates\' notes on activities you can access')}
            aria-label={t('my_notes.all_users_aria', 'Toggle all users notes')}
          >
            <Users className="h-3.5 w-3.5" />
          </Button>
          )}
          {/* Organize by Account toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setViewMode((v) => (v === 'by_account' ? 'link_type' : 'by_account'))}
            className={viewMode === 'by_account' ? 'bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/50 dark:text-blue-200 dark:hover:bg-blue-900/50' : undefined}
            aria-pressed={viewMode === 'by_account'}
            title={viewMode === 'by_account'
              ? t('my_notes.group_by_account_off', 'Organize by Account — click to return to link-type groups')
              : t('my_notes.group_by_account_on', 'Organize by Account: roll Opportunities up under their Account')}
            aria-label={t('my_notes.group_by_account_aria', 'Toggle Organize by Account')}
          >
            <Group className="h-3.5 w-3.5" />
          </Button>
          {/* Date sort */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDateSort((v) => (v === 'desc' ? 'asc' : 'desc'))}
            title={dateSort === 'desc'
              ? t('my_notes.date_sort_desc_active', 'Sort by date: newest first (click to switch)')
              : t('my_notes.date_sort_asc_active', 'Sort by date: oldest first (click to switch)')}
            aria-label={t('my_notes.date_sort_aria', 'Toggle date sort')}
            aria-pressed={dateSort === 'asc'}
          >
            {dateSort === 'desc' ? <CalendarArrowDown className="h-3.5 w-3.5" /> : <CalendarArrowUp className="h-3.5 w-3.5" />}
          </Button>
          {/* Name sort for bucket order */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setNameSort((v) => (v === 'asc' ? 'desc' : 'asc'))}
            title={nameSort === 'asc'
              ? t('my_notes.name_sort_asc_active', 'Sort buckets: A → Z (click to switch)')
              : t('my_notes.name_sort_desc_active', 'Sort buckets: Z → A (click to switch)')}
            aria-label={t('my_notes.name_sort_aria', 'Toggle bucket name sort')}
            aria-pressed={nameSort === 'desc'}
          >
            {nameSort === 'asc' ? <ArrowDownAZ className="h-3.5 w-3.5" /> : <ArrowDownZA className="h-3.5 w-3.5" />}
          </Button>
          {/* Expand all / Collapse all — mirrors the Activities page icons. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setExpandTick((t) => t + 1)}
            title={t('activity.expand_all', 'Expand all')}
            aria-label={t('activity.expand_all', 'Expand all')}
          >
            <Expand className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapseTick((t) => t + 1)}
            title={t('activity.collapse_all', 'Collapse all')}
            aria-label={t('activity.collapse_all', 'Collapse all')}
          >
            <Minimize className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
      </div>

      {showAi ? (
        <MyAiNotesPane
          rows={aiRows}
          loading={aiLoading}
          selectedId={aiSelectedId}
          onSelect={setAiSelectedId}
          viewMode={viewMode}
          dateSort={dateSort}
          nameSort={nameSort}
          expandTick={expandTick}
          collapseTick={collapseTick}
          filtered={!!debouncedQ.trim() || aiReviewOnly}
          onRowChange={onAiRowChange}
          onNotesChanged={() => { void load() }}
        />
      ) : (
      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[320px_1fr]">
        {/* Left: dense grouped list */}
        <div className="flex min-h-0 flex-col overflow-y-auto rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          {loading && (
            <div className="flex justify-center py-10"><Spinner className="h-5 w-5" /></div>
          )}
          {!loading && notes.length === 0 && (
            <p className="p-4 text-xs text-gray-400 dark:text-gray-500">
              {t('my_notes.empty', 'You have not written any notes yet — head to Activities and add one from any activity card.')}
            </p>
          )}
          {!loading && notes.length > 0 && viewMode === 'link_type' && groups.map((g) => {
            const total = Array.from(g.buckets.values()).reduce((s, b) => s + b.notes.length, 0)
            if (total === 0) return null
            const bucketEntries = Array.from(g.buckets.entries())
            // Sort bucket order by name (Not linked stays at bottom).
            bucketEntries.sort((a, b) => {
              if (g.key === 'unlinked') return 0
              return nameSort === 'asc' ? a[1].name.localeCompare(b[1].name) : b[1].name.localeCompare(a[1].name)
            })
            return (
              <SectionAccordion
                key={g.key}
                icon={g.icon}
                title={g.label}
                count={total}
                defaultOpen={g.key !== 'lead' && g.key !== 'unlinked'}
                expandAllTick={expandTick}
                collapseAllTick={collapseTick}
              >
                {bucketEntries.map(([bucketId, bucket]) => {
                  const rows = (
                    <>
                      {bucket.notes.map((n) => (
                        <NoteListRow
                          key={n.id}
                          note={n}
                          selected={n.id === selectedId}
                          onSelect={() => setSelectedId(n.id)}
                          onDelete={() => removeNote(n.id)}
                          onPush={() => setPushTarget({ noteIds: [n.id] })}
                          t={t}
                        />
                      ))}
                    </>
                  )
                  if (g.key === 'unlinked') return <div key={bucketId}>{rows}</div>
                  return (
                    <SectionAccordion key={bucketId} nested title={bucket.name} count={bucket.notes.length} defaultOpen={false} expandAllTick={expandTick} collapseAllTick={collapseTick}>
                      {rows}
                    </SectionAccordion>
                  )
                })}
              </SectionAccordion>
            )
          })}

          {!loading && notes.length > 0 && viewMode === 'by_account' && (
            <>
              {/* accountTree.accounts is already sorted honoring nameSort
                  in the useMemo — do NOT reverse here or we double-sort. */}
              {accountTree.accounts.map((acct) => {
                const total = acct.direct.length + Array.from(acct.opps.values()).reduce((s, o) => s + o.notes.length, 0)
                // Sort Opps within each Account respecting nameSort.
                const opps = Array.from(acct.opps.values()).sort((a, b) => {
                  const c = a.name.localeCompare(b.name)
                  return nameSort === 'asc' ? c : -c
                })
                return (
                  <SectionAccordion
                    key={acct.accountId}
                    icon={Building2}
                    title={acct.accountName}
                    count={total}
                    defaultOpen={false}
                    expandAllTick={expandTick}
                    collapseAllTick={collapseTick}
                  >
                    {acct.direct.length > 0 && (
                      <SectionAccordion nested title={t('my_notes.direct_account_notes', 'Direct')} count={acct.direct.length} defaultOpen={false} expandAllTick={expandTick} collapseAllTick={collapseTick}>
                        {acct.direct.map((n) => (
                          <NoteListRow
                            key={n.id}
                            note={n}
                            selected={n.id === selectedId}
                            onSelect={() => setSelectedId(n.id)}
                            onDelete={() => removeNote(n.id)}
                            onPush={() => setPushTarget({ noteIds: [n.id] })}
                            t={t}
                          />
                        ))}
                      </SectionAccordion>
                    )}
                    {opps.map((opp) => (
                      <SectionAccordion key={opp.id} nested title={opp.name} count={opp.notes.length} defaultOpen={false} icon={Briefcase} expandAllTick={expandTick} collapseAllTick={collapseTick}>
                        {opp.notes.map((n) => (
                          <NoteListRow
                            key={n.id}
                            note={n}
                            selected={n.id === selectedId}
                            onSelect={() => setSelectedId(n.id)}
                            onDelete={() => removeNote(n.id)}
                            onPush={() => setPushTarget({ noteIds: [n.id] })}
                            t={t}
                          />
                        ))}
                      </SectionAccordion>
                    ))}
                  </SectionAccordion>
                )
              })}
              {/* Notes that don't roll up to an Account (Leads, Campaigns, truly unlinked) */}
              {accountTree.noAccount.length > 0 && (
                <SectionAccordion icon={CircleDashed} title={t('my_notes.group_no_account', 'No Account')} count={accountTree.noAccount.length} defaultOpen={false} expandAllTick={expandTick} collapseAllTick={collapseTick}>
                  {accountTree.noAccount.map((n) => (
                    <NoteListRow
                      key={n.id}
                      note={n}
                      selected={n.id === selectedId}
                      onSelect={() => setSelectedId(n.id)}
                      onDelete={() => removeNote(n.id)}
                      onPush={() => setPushTarget({ noteIds: [n.id] })}
                      t={t}
                    />
                  ))}
                </SectionAccordion>
              )}
            </>
          )}
        </div>

        {/* Right: viewer / canvas */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          {selected ? (
            <NoteViewer
              note={selected}
              onPatch={patchNote}
              onDelete={() => removeNote(selected.id)}
              onPushClick={() => setPushTarget({ noteIds: [selected.id] })}
              onReload={load}
              aiFeatures={aiFeatures}
              t={t}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-gray-400 dark:text-gray-500">
              {t('my_notes.viewer_empty', 'Pick a note on the left to open it here.')}
            </div>
          )}
        </div>
      </div>
      )}

      {pushTarget && (
        <PushModal
          noteIds={pushTarget.noteIds}
          notes={notes.filter((n) => pushTarget.noteIds.includes(n.id))}
          onClose={() => setPushTarget(null)}
          onDone={() => { setPushTarget(null); void load() }}
          t={t}
        />
      )}
      </div>
    </div>
  )
}

interface NoteListRowProps {
  note: NoteRow
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  onPush: () => void
  t: TFunction
}

function NoteListRow({ note, selected, onSelect, onDelete, onPush, t }: NoteListRowProps) {
  const crmCtx = useCrmLabelContext()
  const filledMeddpicc = MEDDPICC_KEYS.filter((k) => (note.meddpicc?.[k]?.length ?? 0) > 0)
  const pushed = note.pushes.some((p) => p.status === 'synced')
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-xs transition-colors',
        selected
          ? 'bg-blue-50 dark:bg-blue-950/30'
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60',
      )}
      style={selected && note.activityTypeColor ? { borderLeftColor: note.activityTypeColor } : undefined}
    >
      {note.activityTypeIcon && (
        <DynamicIcon
          name={note.activityTypeIcon}
          className="h-3.5 w-3.5 shrink-0"
          {...(note.activityTypeColor ? { style: { color: note.activityTypeColor } } : {})}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-gray-800 dark:text-gray-100">{note.activityIsPrivateMeeting ? t('activity.private_meeting.title', 'Private meeting') : note.activityTitle ?? t('my_notes.no_activity', '(no activity)')}</span>
        <span className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
          <span title={new Date(note.updatedAt).toLocaleString()}>{formatRelativeTime(note.updatedAt, t)}</span>
          {filledMeddpicc.length > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-0.5">
                {filledMeddpicc.map((k) => (
                  <span
                    key={k}
                    title={`${meddpiccLabel(k, t)} — ${note.meddpicc?.[k]?.length ?? 0}`}
                    className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-purple-400 text-[7px] font-bold leading-none text-white dark:bg-purple-500"
                  >
                    {MEDDPICC_LETTER[k]}
                  </span>
                ))}
              </span>
            </>
          )}
          {pushed && <CheckCircle2 className="ml-0.5 h-2.5 w-2.5 text-green-600 dark:text-green-400" />}
        </span>
      </div>
      {/* v1.128.0: on other users' notes, replace the Push/Delete
          hover-actions with a persistent user-lock indicator so the
          list row makes it obvious the note is read-only for the
          caller. Own notes keep the hover actions. */}
      {note.canEdit ? (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <span
            onClick={(e) => { e.stopPropagation(); onPush() }}
            className="rounded p-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
            title={t('my_notes.push_button', { context: crmCtx })}
          >
            <Send className="h-3 w-3" />
          </span>
          <span
            onClick={(e) => { e.stopPropagation(); if (window.confirm(t('activity.notes.delete_confirm', 'Delete this note?'))) { void api.delete(`/api/notes/${note.id}`).then(() => onDelete()) } }}
            className="rounded p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
            title={t('activity.notes.delete', 'Delete')}
          >
            <Trash2 className="h-3 w-3" />
          </span>
        </span>
      ) : (
        <span
          className="flex shrink-0 items-center gap-0.5 text-gray-400 dark:text-gray-500"
          title={t('my_notes.list_row_readonly', 'Read-only — belongs to {{name}}', { name: note.createdBy.displayName ?? '' })}
        >
          <UserLock className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  )
}

interface NoteViewerProps {
  note: NoteRow
  onPatch: (updated: Partial<NoteRow> & { id: string }) => void
  onDelete: () => void
  onPushClick: () => void
  onReload: () => Promise<void>
  aiFeatures: Partial<Record<AiFeature, boolean>>
  t: TFunction
}

function NoteViewer({ note, onPatch, onDelete, onPushClick, onReload, aiFeatures, t }: NoteViewerProps) {
  const crmCtx = useCrmLabelContext()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [meddpiccOpenFor, setMeddpiccOpenFor] = useState<MeddpiccKey | null>(null)
  const [organizePreview, setOrganizePreview] = useState<{ original: string; suggested: string } | null>(null)
  const [organizeBusy, setOrganizeBusy] = useState(false)
  const [linkSuggestions, setLinkSuggestions] = useState<Array<{ type: string; id: string; name: string; extra?: string; confidence: number }> | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  // v1.260.0: "Also post this to Engineer Notes on the linked Project" —
  // same feature and same gate as NotesPanel's checkbox (a Project/Eval
  // record must actually be linked), now also available from My Notes,
  // not just the activity Notes tab.
  const [postToEngineerNotes, setPostToEngineerNotes] = useState(false)
  const [engineerNotesError, setEngineerNotesError] = useState<string | null>(null)
  // v1.387.0: never offered while Projects are off.
  const crmProjects = useCrmProjects()
  const canPostEngineerNotes = crmProjects && !!note.crmRelatedType && !!note.crmRelatedId
  const linked = note.crmWhatId ? { type: note.crmWhatType, name: note.crmWhatName, id: note.crmWhatId }
    : (note.crmWhoType === 'Lead' && note.crmWhoId) ? { type: 'Lead', name: note.crmWhoName, id: note.crmWhoId }
    : null
  const LinkedIcon = sfIcon(linked?.type ?? null)
  const canPush = linked && (linked.type === 'Opportunity' || linked.type === 'Account')

  useEffect(() => { setEditing(false); setDraft(note.body); setLinkSuggestions(null); setOrganizePreview(null) }, [note.id])

  async function saveBody() {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === note.body.trim()) { setEditing(false); return }
    const res = await api.patch<{ body: string; updatedAt: string }>(`/api/notes/${note.id}`, { body: trimmed })
    if (res.error) return
    onPatch({ id: note.id, body: res.data?.body ?? trimmed, updatedAt: res.data?.updatedAt ?? new Date().toISOString() })

    // Engineer Notes prepend-update — secondary, non-blocking write. The
    // note body above has already saved and must not be undone by a
    // Salesforce failure here; mirrors NotesPanel's submitNew().
    if (postToEngineerNotes && canPostEngineerNotes && note.crmRelatedType && note.crmRelatedId && note.teamId) {
      const prependRes = await api.post(`${crmApiBase()}/field-prepend`, {
        teamId: note.teamId,
        sobject: note.crmRelatedType,
        appField: 'eval_engineer_notes',
        recordId: note.crmRelatedId,
        text: trimmed,
      })
      if (prependRes.error) {
        setEngineerNotesError(prependRes.error)
      } else {
        setPostToEngineerNotes(false)
        setEngineerNotesError(null)
      }
    }

    setEditing(false)
  }

  async function saveMeddpicc(next: MeddpiccMap) {
    const res = await api.patch<{ meddpicc: MeddpiccMap; updatedAt: string }>(`/api/notes/${note.id}`, { meddpicc: next })
    if (res.error) return
    onPatch({ id: note.id, meddpicc: next, updatedAt: res.data?.updatedAt ?? new Date().toISOString() })
  }

  async function runOrganize() {
    setOrganizeBusy(true)
    const res = await api.post<{ original: string; suggested: string }>(`/api/ai/organize-note`, { noteId: note.id })
    setOrganizeBusy(false)
    if (res.error || !res.data) return
    setOrganizePreview(res.data)
  }
  async function applyOrganize() {
    if (!organizePreview) return
    const res = await api.patch<{ body: string; updatedAt: string }>(`/api/notes/${note.id}`, { body: organizePreview.suggested })
    if (res.error) return
    onPatch({ id: note.id, body: res.data?.body ?? organizePreview.suggested, updatedAt: res.data?.updatedAt ?? new Date().toISOString() })
    setOrganizePreview(null)
  }

  async function runLinkSuggestions() {
    setLinkBusy(true)
    const res = await api.post<{ suggestions: Array<{ type: string; id: string; name: string; extra?: string; confidence: number }> }>(`/api/ai/link-suggestions`, { noteId: note.id })
    setLinkBusy(false)
    if (res.error || !res.data) { setLinkSuggestions([]); return }
    setLinkSuggestions(res.data.suggestions)
  }

  async function applyLink(sug: { type: string; id: string; name: string }) {
    // Attach to the underlying activity — server enforces same
    // ownership rules as the SF Link picker in the edit drawer.
    const payload: Record<string, unknown> = {}
    if (sug.type === 'Opportunity' || sug.type === 'Account' || sug.type === 'Campaign') {
      payload['crmWhatId'] = sug.id
      payload['crmWhatType'] = sug.type
      payload['crmWhatName'] = sug.name
    } else if (sug.type === 'Lead') {
      payload['crmWhoId'] = sug.id
      payload['crmWhoType'] = 'Lead'
      payload['crmWhoName'] = sug.name
    }
    const res = await api.patch(`/api/activities/${note.activityId}`, payload)
    if (res.error) return
    await onReload()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Header */}
      <div className="border-b border-gray-100 p-4 dark:border-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              {note.activityTypeIcon && (
                <DynamicIcon
                  name={note.activityTypeIcon}
                  className="h-4 w-4 shrink-0"
                  {...(note.activityTypeColor ? { style: { color: note.activityTypeColor } } : {})}
                />
              )}
              <span className="truncate font-semibold text-gray-900 dark:text-gray-100">
                {note.activityIsPrivateMeeting ? t('activity.private_meeting.title', 'Private meeting') : note.activityTitle ?? t('my_notes.no_activity', '(no activity)')}
              </span>
              {linked && LinkedIcon && (
                <span className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                  <LinkedIcon className="h-3 w-3" />
                  {linked.name ?? linked.type}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              <span title={new Date(note.createdAt).toLocaleString()}>{t('my_notes.created', 'Created')}: {formatRelativeTime(note.createdAt, t)}</span>
              <span>·</span>
              <span title={new Date(note.updatedAt).toLocaleString()}>{t('my_notes.updated', 'Updated')}: {formatRelativeTime(note.updatedAt, t)}</span>
              {note.createdBy.displayName && (
                <>
                  <span>·</span>
                  <span>{note.createdBy.displayName}</span>
                </>
              )}
            </div>
            {note.pushes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {/* v1.260.0 fix: a retried push creates a NEW activity_note_pushes
                    row rather than overwriting the old failed one (see
                    enqueuePush's dedupe rule), so note.pushes can hold both a
                    stale failed attempt and the successful retry that superseded
                    it. Badges must reflect only the LATEST attempt per target —
                    otherwise a note that pushed successfully on retry kept
                    showing "Push failed" forever from the earlier row. */}
                {latestPushesByTarget(note.pushes).map((p) => {
                  if (p.status === 'synced') {
                    return (
                      <Badge
                        key={p.id}
                        variant="success"
                        className="inline-flex items-center gap-1 text-[9px]"
                        title={p.syncedAt ? new Date(p.syncedAt).toLocaleString() : undefined}
                      >
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        {t('my_notes.pushed_to', 'Pushed to {{type}}', { type: p.crmTargetType })}{p.crmTargetName ? `: ${p.crmTargetName}` : ''}
                      </Badge>
                    )
                  }
                  if (p.status === 'pending') {
                    return (
                      <Badge key={p.id} variant="warning" className="inline-flex items-center gap-1 text-[9px]">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        {t('my_notes.push_pending', { context: crmCtx })}
                      </Badge>
                    )
                  }
                  if (p.status === 'failed') {
                    return (
                      <Badge
                        key={p.id}
                        variant="destructive"
                        className="inline-flex items-center gap-1 text-[9px]"
                        title={[p.error, new Date(p.createdAt).toLocaleString()].filter(Boolean).join(' — ')}
                      >
                        <AlertCircle className="h-2.5 w-2.5" />
                        {t('my_notes.push_failed_chip', 'Push failed')}
                      </Badge>
                    )
                  }
                  return null
                })}
              </div>
            )}
          </div>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* v1.128.0: on other users' notes every mutation is
                disabled — only Copy stays enabled. Show the buttons
                grayed instead of hiding them so the layout stays
                consistent between own and others' notes. */}
            {aiFeatures.note_organize !== false && (
              <Button size="sm" variant="outline" onClick={runOrganize} disabled={organizeBusy || !note.canEdit} title={!note.canEdit ? t('my_notes.readonly_hint', 'Read-only — this note belongs to another user') : t('my_notes.ai_organize_tip')}>
                {organizeBusy ? <Spinner className="mr-1 h-3 w-3" /> : <Sparkles className="mr-1 h-3 w-3" />}
                {t('my_notes.ai_organize', 'AI Organize')}
              </Button>
            )}
            <Button size="sm" onClick={onPushClick} disabled={!canPush || !note.canEdit} title={!note.canEdit ? t('my_notes.readonly_hint', 'Read-only — this note belongs to another user') : (canPush ? undefined : t('my_notes.push_unavailable_tip', { context: crmCtx }))}>
              <Send className="mr-1 h-3 w-3" />
              {t('my_notes.push_button', { context: crmCtx })}
            </Button>
            {!editing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setEditing(true); setDraft(note.body) }}
                disabled={!note.canEdit}
                title={!note.canEdit ? t('my_notes.readonly_hint', 'Read-only — this note belongs to another user') : undefined}
              >
                <Pencil className="mr-1 h-3 w-3" />
                {t('activity.notes.edit', 'Edit')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!note.canEdit) return
                if (!window.confirm(t('activity.notes.delete_confirm', 'Delete this note?'))) return
                const res = await api.delete(`/api/notes/${note.id}`)
                if (!res.error) onDelete()
              }}
              disabled={!note.canEdit}
              title={!note.canEdit ? t('my_notes.readonly_hint', 'Read-only — this note belongs to another user') : undefined}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              {t('activity.notes.delete', 'Delete')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const plain = note.body.replace(/[*_`#>-]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                void navigator.clipboard.writeText(plain)
              }}
              title={t('my_notes.copy_plain_tip', 'Copy without Markdown formatting')}
            >
              <Copy className="mr-1 h-3 w-3" />
              {t('my_notes.copy_plain', 'Copy')}
            </Button>
            {/* v1.127.0: Private toggle. Only the owner (canEdit) can
                flip it. Locked = only owner + App Admins see this note.
                v1.128.0: render disabled on other users' notes too so
                the toolbar stays visually consistent. */}
            {
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!note.canEdit) return
                  const res = await api.patch(`/api/notes/${note.id}`, { isPrivate: !note.isPrivate })
                  if (!res.error) onDelete()
                }}
                disabled={!note.canEdit}
                className={note.isPrivate ? 'bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200' : undefined}
                title={!note.canEdit
                  ? t('my_notes.readonly_hint', 'Read-only — this note belongs to another user')
                  : note.isPrivate
                    ? t('my_notes.private_on', 'Private — only you and App Admins can see this note. Click to make it visible to your team.')
                    : t('my_notes.private_off', 'Make this note private (only you and App Admins can see it).')}
              >
                {note.isPrivate ? <Lock className="mr-1 h-3 w-3" /> : <LockOpen className="mr-1 h-3 w-3" />}
                {note.isPrivate ? t('my_notes.private', 'Private') : t('my_notes.make_private', 'Private')}
              </Button>
            }
          </div>
        </div>
      </div>

      {/* Ask My Notes chat — kept at the top so the note/all-notes AI search
          is easy to find above the MEDDPICC row and body. */}
      {aiFeatures.notes_chat !== false && <NotesChat noteId={note.id} t={t} />}

      {/* MEDDPICC row */}
      <div className="border-b border-gray-100 px-4 py-2 dark:border-gray-800">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('my_notes.meddpicc_row', 'MEDDPICC')}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {MEDDPICC_KEYS.map((k) => {
            const count = note.meddpicc?.[k]?.length ?? 0
            return (
              <button
                key={k}
                type="button"
                onClick={() => setMeddpiccOpenFor((cur) => (cur === k ? null : k))}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                  count > 0
                    ? 'border-purple-300 bg-purple-50 text-purple-800 dark:border-purple-700 dark:bg-purple-950/40 dark:text-purple-200'
                    : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400',
                )}
                title={meddpiccLabel(k, t) + (count > 0 ? ` — ${count}` : '')}
              >
                {meddpiccLabel(k, t)}
                {count > 0 && <span className="rounded bg-purple-200 px-1 text-[9px] font-semibold text-purple-800 dark:bg-purple-800 dark:text-purple-100">{count}</span>}
              </button>
            )
          })}
        </div>
        {meddpiccOpenFor && (
          <MeddpiccEditor
            k={meddpiccOpenFor}
            existing={note.meddpicc?.[meddpiccOpenFor] ?? []}
            readOnly={!note.canEdit}
            onClose={() => setMeddpiccOpenFor(null)}
            onSave={async (values) => {
              const next: MeddpiccMap = { ...(note.meddpicc ?? {}), [meddpiccOpenFor]: values }
              await saveMeddpicc(next)
              setMeddpiccOpenFor(null)
            }}
            t={t}
          />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 p-4">
        {editing ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-end">
              <MarkdownHelpPopover />
            </div>
            <Textarea rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
            {canPostEngineerNotes && (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={postToEngineerNotes}
                  onChange={(e) => { setPostToEngineerNotes(e.target.checked); setEngineerNotesError(null) }}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300 dark:border-gray-600"
                />
                {t('activity.form.post_to_engineer_notes', 'Also post this to Engineer Notes on the linked Project')}
              </label>
            )}
            {engineerNotesError && (
              <p className="text-[10px] text-red-600 dark:text-red-400">{engineerNotesError.startsWith('errors.') ? t(engineerNotesError) : engineerNotesError}</p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveBody} disabled={!draft.trim() || draft.trim() === note.body.trim()}>
                <Check className="mr-1 h-3 w-3" />
                {t('common.save', 'Save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(note.body) }}>
                <X className="mr-1 h-3 w-3" />
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="md-body text-gray-700 dark:text-gray-200">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{note.body}</ReactMarkdown>
          </div>
        )}
      </div>

      {/* AI Link Suggestions — only when unlinked */}
      {!linked && (
        <div className="border-t border-gray-100 p-4 dark:border-gray-800">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200">
            <LinkIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            {t('my_notes.ai_link_suggestions', 'AI Link Suggestions')}
          </div>
          {!linkSuggestions && (
            <Button size="sm" variant="outline" onClick={runLinkSuggestions} disabled={linkBusy}>
              {linkBusy ? <Spinner className="mr-1 h-3 w-3" /> : <Sparkles className="mr-1 h-3 w-3" />}
              {t('my_notes.ai_link_run', { context: crmCtx, defaultValue: 'Find matching Salesforce records' })}
            </Button>
          )}
          {linkSuggestions && linkSuggestions.length === 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('my_notes.ai_link_empty', 'No confident matches found.')}</p>
          )}
          {linkSuggestions && linkSuggestions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {linkSuggestions.map((s) => {
                const Icon = sfIcon(s.type)
                return (
                  <div key={`${s.type}:${s.id}`} className="flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800">
                    {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-gray-600 dark:text-gray-300" />}
                    <span className="flex-1 truncate font-medium text-gray-800 dark:text-gray-100">
                      {s.name}
                      {s.extra && <span className="ml-1 text-[10px] text-gray-500 dark:text-gray-400">· {s.extra}</span>}
                    </span>
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{Math.round(s.confidence * 100)}%</span>
                    <Button size="sm" onClick={() => applyLink(s)}>
                      {t('my_notes.ai_link_apply', 'Link')}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Organize preview modal */}
      {organizePreview && (
        <Dialog open={true} onClose={() => setOrganizePreview(null)} title={t('my_notes.ai_organize_preview', 'AI Organize — Preview')} titleIcon={Sparkles}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('my_notes.ai_organize_original', 'Original')}
                </div>
                <div className="max-h-72 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-800">
                  <div className="md-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{organizePreview.original}</ReactMarkdown>
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('my_notes.ai_organize_suggested', 'Suggested')}
                </div>
                <div className="max-h-72 overflow-y-auto rounded border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-800 dark:bg-blue-950/30">
                  <div className="md-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{organizePreview.suggested}</ReactMarkdown>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOrganizePreview(null)}>{t('common.cancel', 'Cancel')}</Button>
              <Button onClick={applyOrganize}>{t('my_notes.ai_organize_apply', 'Apply')}</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function meddpiccLabel(k: MeddpiccKey, t: TFunction): string {
  const map: Record<MeddpiccKey, string> = {
    metrics: t('meddpicc.metrics', 'Metrics'),
    economic_buyer: t('meddpicc.economic_buyer', 'Economic Buyer'),
    decision_criteria: t('meddpicc.decision_criteria', 'Decision Criteria'),
    decision_process: t('meddpicc.decision_process', 'Decision Process'),
    paper_process: t('meddpicc.paper_process', 'Paper Process'),
    identified_pain: t('meddpicc.identified_pain', 'Identified Pain'),
    champion: t('meddpicc.champion', 'Champion'),
    competition: t('meddpicc.competition', 'Competition'),
  }
  return map[k]
}

interface MeddpiccEditorProps {
  k: MeddpiccKey
  existing: string[]
  readOnly?: boolean
  onClose: () => void
  onSave: (values: string[]) => Promise<void>
  t: TFunction
}

function MeddpiccEditor({ k, existing, readOnly = false, onClose, onSave, t }: MeddpiccEditorProps) {
  const [values, setValues] = useState<string[]>(existing.length > 0 ? existing : [''])
  const [busy, setBusy] = useState(false)
  // Non-owners can view another user's MEDDPICC entries but never edit or save.
  if (readOnly) {
    const filled = existing.filter((v) => v.trim().length > 0)
    return (
      <div className="mt-2 rounded border border-purple-200 bg-purple-50/60 p-2 text-xs dark:border-purple-800 dark:bg-purple-950/30">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-purple-800 dark:text-purple-200">{meddpiccLabel(k, t)}</span>
          <button type="button" onClick={onClose} className="text-purple-800 hover:text-purple-900 dark:text-purple-200 dark:hover:text-purple-100">
            <X className="h-3 w-3" />
          </button>
        </div>
        {filled.length > 0 ? (
          <ul className="flex flex-col gap-1 pl-1">
            {filled.map((v, i) => (
              <li key={i} className="flex items-start gap-1.5 text-gray-700 dark:text-gray-200">
                <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-purple-400" />
                <span className="whitespace-pre-wrap break-words">{v}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="italic text-gray-400 dark:text-gray-500">{t('my_notes.meddpicc_empty', 'Nothing recorded.')}</p>
        )}
      </div>
    )
  }
  return (
    <div className="mt-2 rounded border border-purple-200 bg-purple-50/60 p-2 text-xs dark:border-purple-800 dark:bg-purple-950/30">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-purple-800 dark:text-purple-200">{meddpiccLabel(k, t)}</span>
        <button type="button" onClick={onClose} className="text-purple-800 hover:text-purple-900 dark:text-purple-200 dark:hover:text-purple-100">
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input value={v} onChange={(e) => setValues((s) => s.map((x, ix) => (ix === i ? e.target.value : x)))} className="text-xs" />
            <button
              type="button"
              onClick={() => setValues((s) => s.filter((_, ix) => ix !== i).concat(s.length === 1 ? [''] : []))}
              className="text-purple-700 hover:text-purple-900 dark:text-purple-300"
              title={t('common.remove', 'Remove')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setValues((s) => [...s, ''])} className="self-start text-[11px] text-purple-700 underline hover:text-purple-900 dark:text-purple-300">
          {t('my_notes.meddpicc_add', '+ Add another')}
        </button>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
        <Button
          size="sm"
          onClick={async () => {
            setBusy(true)
            await onSave(values.map((v) => v.trim()).filter((v) => v.length > 0))
            setBusy(false)
          }}
          disabled={busy}
        >
          {busy ? <Spinner className="mr-1 h-3 w-3" /> : <Check className="mr-1 h-3 w-3" />}
          {t('common.save', 'Save')}
        </Button>
      </div>
    </div>
  )
}

interface ChatMessage { role: 'user' | 'assistant'; text: string; citations?: Array<{ index: number; noteId: string; activityId: string; activityTitle: string | null; crmWhatName: string | null }> }

function NotesChat({ noteId, t }: { noteId: string; t: TFunction }) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<'current' | 'all'>('all')
  const [busy, setBusy] = useState(false)

  async function ask() {
    if (!q.trim() || busy) return
    const question = q.trim()
    setHistory((h) => [...h, { role: 'user', text: question }])
    setQ('')
    setBusy(true)
    const res = await api.post<{ answer: string; citations: Array<{ index: number; noteId: string; activityId: string; activityTitle: string | null; crmWhatName: string | null }> }>('/api/ai/notes-chat', { question, scope, currentNoteId: noteId })
    setBusy(false)
    if (res.error || !res.data) {
      const text = res.error === 'ai_budget_reached'
        ? t('my_notes.chat_budget_reached')
        : t('my_notes.chat_error', 'The chat service is not available right now.')
      setHistory((h) => [...h, { role: 'assistant', text }])
      return
    }
    setHistory((h) => [...h, { role: 'assistant', text: res.data!.answer, citations: res.data!.citations }])
  }

  return (
    <div className="border-t border-gray-100 p-4 dark:border-gray-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200">
          <MessageSquare className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
          {t('my_notes.chat_title', 'Ask My Notes')}
        </div>
        <div className="inline-flex rounded-md border border-gray-200 text-[10px] dark:border-gray-700">
          <button
            type="button"
            onClick={() => setScope('all')}
            className={cn('inline-flex items-center gap-1 px-2 py-0.5', scope === 'all' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800')}
          >
            <List className="h-3 w-3" />
            {t('my_notes.chat_scope_all', 'All notes')}
          </button>
          <button
            type="button"
            onClick={() => setScope('current')}
            className={cn('inline-flex items-center gap-1 px-2 py-0.5', scope === 'current' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800')}
          >
            <FileText className="h-3 w-3" />
            {t('my_notes.chat_scope_current', 'This note')}
          </button>
        </div>
      </div>
      {history.length > 0 && (
        <div className="mb-2 flex flex-col gap-2">
          {history.map((m, i) => (
            <div key={i} className={cn('rounded-md px-2 py-1.5 text-xs', m.role === 'user'
              ? 'bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100'
              : 'bg-gray-50 text-gray-800 dark:bg-gray-800 dark:text-gray-100',
            )}>
              <div className="md-body whitespace-pre-wrap">
                <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{m.text}</ReactMarkdown>
              </div>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.citations.map((c) => (
                    <span key={c.index} className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[9px] text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200" title={c.activityTitle ?? ''}>
                      [{c.index}] {c.crmWhatName ?? c.activityTitle ?? 'note'}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() } }}
          placeholder={t('my_notes.chat_placeholder', 'Ask AI a question about your notes')}
        />
        <Button onClick={ask} disabled={!q.trim() || busy}>
          {busy ? <Spinner className="mr-1 h-3 w-3" /> : <Send className="mr-1 h-3 w-3" />}
          {t('my_notes.chat_send', 'Ask')}
        </Button>
      </div>
    </div>
  )
}

interface PushModalProps {
  noteIds: string[]
  notes: NoteRow[]
  onClose: () => void
  onDone: () => void
  t: TFunction
}

function PushModal({ noteIds, notes, onClose, onDone, t }: PushModalProps) {
  const crmCtx = useCrmLabelContext()
  const [mode, setMode] = useState<'opp' | 'account'>('opp')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const canOpp = notes.every((n) => n.crmWhatType === 'Opportunity' && n.crmWhatId)
  const canAcct = notes.every((n) => n.crmWhatType === 'Account' && n.crmWhatId)

  useEffect(() => { if (canOpp) setMode('opp'); else if (canAcct) setMode('account') }, [canOpp, canAcct])

  async function submit() {
    setBusy(true); setErr(null)
    for (const n of notes) {
      const targets: Array<{ crmType: 'Opportunity' | 'Account'; sfId: string; sfName?: string | null }> = []
      if (mode === 'opp' && n.crmWhatType === 'Opportunity' && n.crmWhatId) {
        targets.push({ crmType: 'Opportunity', sfId: n.crmWhatId, sfName: n.crmWhatName })
      }
      if (mode === 'account' && n.crmWhatType === 'Account' && n.crmWhatId) {
        targets.push({ crmType: 'Account', sfId: n.crmWhatId, sfName: n.crmWhatName })
      }
      if (targets.length === 0) continue
      const res = await api.post(`/api/notes/${n.id}/push`, { targets })
      if (res.error) { setErr(res.error); setBusy(false); return }
    }
    setBusy(false)
    onDone()
  }

  return (
    <Dialog open={true} onClose={onClose} title={t('my_notes.push_modal_title', { context: crmCtx })} titleIcon={Send}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-700 dark:text-gray-200">
          {t('my_notes.push_modal_body', { count: noteIds.length, context: crmCtx, defaultValue: 'Publish {{count}} note(s) as a Salesforce ContentNote linked to:' })}
        </p>
        <div className="flex flex-col gap-2 text-sm">
          <label className={cn('flex cursor-pointer items-center gap-2', !canOpp && 'opacity-50')}>
            <input type="radio" checked={mode === 'opp'} disabled={!canOpp} onChange={() => setMode('opp')} />
            <Briefcase className="h-4 w-4" />
            {t('my_notes.push_target_opp', { context: crmCtx })}
          </label>
          <label className={cn('flex cursor-pointer items-center gap-2', !canAcct && 'opacity-50')}>
            <input type="radio" checked={mode === 'account'} disabled={!canAcct} onChange={() => setMode('account')} />
            <Building2 className="h-4 w-4" />
            {t('my_notes.push_target_account', { context: crmCtx })}
          </label>
        </div>
        {err && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{err}</div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Spinner className="mr-1 h-3 w-3" /> : <Send className="mr-1 h-3 w-3" />}
            {t('my_notes.push_confirm', 'Push')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
