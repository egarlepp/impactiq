import { useRef, useState, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Users, X } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { api } from '../../lib/api.js'

interface SubteamOption { id: string; name: string }
interface MemberRow { id: string; displayName: string; email: string }

interface Props {
  teamId: string
  subteams: SubteamOption[]
  subteamIds: string[]
  onSubteamIdsChange: (next: string[]) => void
  userIds: string[]
  onUserIdsChange: (next: string[]) => void
  className?: string
}

// v1.264.0: shared "Subteam filter" widget — PRD §7: "Add a filter to show
// subteam members when a subteam is selected. It should be a chevron that
// when opened will show those members of that subteam to save space. It
// will allow choosing multiple people."
//
// Used by both Scheduling and Dashboard: several subteams AND/OR several
// individual people can be in view at once — subteamIds ∪ userIds, unioned
// server-side. The two call sites differ only in what "no selection" means
// (Scheduling defaults to the caller's own subteam; Dashboard starts at
// "All" since it's a reporting surface, not a personal calendar view) —
// that default lives in each page's own state initialization, not here.
export function SubteamFilter({ teamId, subteams, subteamIds, onSubteamIdsChange, userIds, onUserIdsChange, className }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [membersBySubteam, setMembersBySubteam] = useState<Record<string, MemberRow[]>>({})
  const [loadingSubteam, setLoadingSubteam] = useState<string | null>(null)
  const [rect, setRect] = useState<{ top: number; right: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // Rendered into document.body via a portal with position:fixed so it
  // escapes any ancestor overflow/stacking context — otherwise the sidebar
  // (or a scrolling parent) clips it, since this chip commonly sits near
  // the left edge of the filter row. Same pattern as SingleSelect/MultiSelect.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const b = btnRef.current.getBoundingClientRect()
    setRect({ top: b.bottom + 4, right: window.innerWidth - b.right })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onResize() { setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  async function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    if (!membersBySubteam[id]) {
      setLoadingSubteam(id)
      const res = await api.get<MemberRow[]>(`/api/teams/${teamId}/subteams/${id}/members`)
      setMembersBySubteam((prev) => ({ ...prev, [id]: res.data ?? [] }))
      setLoadingSubteam(null)
    }
  }

  function toggleSubteam(id: string) {
    const on = subteamIds.includes(id)
    if (on) {
      onSubteamIdsChange(subteamIds.filter((v) => v !== id))
      return
    }
    onSubteamIdsChange([...subteamIds, id])
    // Turning the whole subteam on supersedes any individually-picked
    // members from it — clear them so the server-side union doesn't
    // silently also double up on the same people, and so re-collapsing
    // the row doesn't leave a stale, invisible narrower selection behind.
    const memberIds = membersBySubteam[id]?.map((m) => m.id) ?? []
    if (memberIds.length > 0) onUserIdsChange(userIds.filter((v) => !memberIds.includes(v)))
  }

  function toggleMember(subteamId: string, memberId: string) {
    const on = userIds.includes(memberId)
    if (on) {
      onUserIdsChange(userIds.filter((v) => v !== memberId))
      return
    }
    onUserIdsChange([...userIds, memberId])
    // Picking a specific person means "just these people", not "the whole
    // subteam" — uncheck the subteam-level box if it was on so the server
    // doesn't also pull in everyone else on it.
    if (subteamIds.includes(subteamId)) onSubteamIdsChange(subteamIds.filter((v) => v !== subteamId))
  }

  const selectedNames = subteams.filter((s) => subteamIds.includes(s.id)).map((s) => s.name)
  const summary =
    subteamIds.length === 0
      ? t('leader.filter_user_all', 'All')
      : selectedNames.length <= 2
      ? selectedNames.join(', ')
      : `${selectedNames.slice(0, 2).join(', ')}, +${selectedNames.length - 2}`

  return (
    <div className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        <Users className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
        <span className="text-gray-500 dark:text-gray-400">{t('scheduling.filter_subteams', 'Subteams')}:</span>
        <span className="max-w-[10rem] truncate">{summary}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && rect && createPortal(
        <div
          ref={popRef}
          className="fixed z-[100] w-72 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800"
          style={{ top: rect.top, right: rect.right }}
        >
          <div className="flex items-center justify-between px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <span>{t('scheduling.filter_subteams', 'Subteams')}</span>
            {(subteamIds.length > 0 || userIds.length > 0) && (
              <button type="button" onClick={() => { onSubteamIdsChange([]); onUserIdsChange([]) }} className="flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400">
                <X className="h-2.5 w-2.5" /> {t('common.clear', 'Clear')}
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {subteams.length === 0 ? (
              <p className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t('scheduling.no_subteams', 'No subteams on this team.')}</p>
            ) : (
              subteams.map((s) => {
                const on = subteamIds.includes(s.id)
                const isOpen = expanded.has(s.id)
                const memberRows = membersBySubteam[s.id]
                return (
                  <div key={s.id} className="border-b border-gray-50 last:border-b-0 dark:border-gray-700/60">
                    <div className="flex w-full items-center gap-1 px-1 py-0.5">
                      <button
                        type="button"
                        onClick={() => toggleSubteam(s.id)}
                        className="flex flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        <span className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                          on ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 dark:border-gray-500',
                        )}>
                          {on && <Check className="h-2.5 w-2.5" />}
                        </span>
                        <span className="flex-1 truncate text-gray-700 dark:text-gray-200">{s.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleExpand(s.id)}
                        title={t('scheduling.expand_members_hint', 'Show/hide members of this subteam')}
                        aria-label={t('scheduling.expand_members_hint', 'Show/hide members of this subteam')}
                        className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                      >
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {isOpen && (
                      <div className="ml-6 flex flex-col gap-0.5 pb-1">
                        {loadingSubteam === s.id ? (
                          <span className="px-2 py-1 text-[11px] text-gray-400">{t('common.loading', 'Loading...')}</span>
                        ) : memberRows && memberRows.length > 0 ? (
                          memberRows.map((m) => {
                            const memberOn = userIds.includes(m.id)
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => toggleMember(s.id, m.id)}
                                className="flex items-center gap-2 rounded px-2 py-1 text-left text-[11px] hover:bg-gray-100 dark:hover:bg-gray-700"
                              >
                                <span className={cn(
                                  'flex h-3 w-3 shrink-0 items-center justify-center rounded border',
                                  memberOn ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 dark:border-gray-500',
                                )}>
                                  {memberOn && <Check className="h-2 w-2" />}
                                </span>
                                <span className="flex-1 truncate text-gray-600 dark:text-gray-300">{m.displayName}</span>
                              </button>
                            )
                          })
                        ) : (
                          <span className="px-2 py-1 text-[11px] italic text-gray-400">{t('scheduling.no_members', 'No members.')}</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
