import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { BookOpenCheck, CalendarCheck, GitCompareArrows, LayoutDashboard, LifeBuoy, Search, X } from 'lucide-react'
import { api } from '../../lib/api.js'
import { cn } from '../../lib/utils.js'
import { useCurrentUser, hasPermission } from '../../hooks/useCurrentUser.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'
import { useProjectsEnabled } from '../../store/evaluationSource.js'
import { useTeam } from '../../hooks/useTeam.js'
import { dashboardHref, visibleDashboardGroups } from '../../lib/dashboardTabs.js'
import { GUIDE_DISTINCTIONS_ANCHOR, guideCardTypes, guideTypeAnchor } from '../../lib/activityTypeGuide.js'
import { SETTINGS_PAGE, visibleAppPages } from '../../lib/appPages.js'
import { ADMIN_CATEGORIES, SECTION_ICONS, canOpenAdminSection } from '../../lib/adminSections.js'
import { HOW_TO_USE_SECTIONS, HOW_TO_USE_SECTION_PAGE_KEY, howToUseHref } from '../../lib/howToUse.js'

// v1.420.0: VectorIQ-style global search in the page header. Opens from the
// search button or Ctrl/Cmd+K. Pages, dashboards, Admin sections, the Guide
// and the How to Use manual are filtered locally from the same lists their own
// pages use, under the same Role Management keys, so a result never links to
// something the user can't open (v1.421.0 added dashboards, the Guide's text
// and the manual's text). The caller's own activities come from
// GET /api/activities/search.

const MIN_REMOTE_QUERY = 2
const LOCAL_RESULTS_PER_GROUP = 5
const REMOTE_DEBOUNCE_MS = 200

interface ActivityHit {
  id: string
  title: string
  startDatetime: string
  status: 'draft' | 'submitted'
  crmWhatName: string | null
  crmWhoName: string | null
}

interface ResultItem {
  key: string
  label: string
  detail?: string
  icon: ComponentType<{ className?: string }>
  href: string
}

interface ResultGroup {
  key: string
  label: string
  items: ResultItem[]
}

const SNIPPET_RADIUS = 40

function matches(label: string, needle: string): boolean {
  return label.toLowerCase().includes(needle)
}

// Markdown and line breaks flattened to one line of plain text.
function plainText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The words around the first match, for the result's second line.
function snippet(text: string, needle: string): string | null {
  const plain = plainText(text)
  const at = plain.toLowerCase().indexOf(needle)
  if (at < 0) return null
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(plain.length, at + needle.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`
}

export function GlobalSearch() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  // Ctrl/Cmd+K opens it from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('search.button_title')}
        aria-label={t('search.button_title')}
        className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
      >
        <Search className="h-4 w-4" />
      </button>
      {open && <SearchDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useCurrentUser()
  const crmCtx = useCrmLabelContext()
  const projectsOn = useProjectsEnabled()
  const { active, activityTypes, subtypesByTypeId } = useTeam()
  const canGuide = hasPermission(user, 'guide')
  const guideTeamId = active && !active.isAll ? active.id : null
  const [distinctions, setDistinctions] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activities, setActivities] = useState<ActivityHit[]>([])
  const [loadingRemote, setLoadingRemote] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const needle = query.trim().toLowerCase()

  useEffect(() => { inputRef.current?.focus() }, [])

  // The Guide's team-wide Distinctions text, read once per opening.
  useEffect(() => {
    if (!canGuide || !guideTeamId) { setDistinctions(null); return }
    let cancelled = false
    api.get<{ guideDistinctions: string | null }>(`/api/teams/${guideTeamId}/guide-distinctions`)
      .then((res) => { if (!cancelled) setDistinctions(res.data?.guideDistinctions ?? null) })
      .catch(() => { if (!cancelled) setDistinctions(null) })
    return () => { cancelled = true }
  }, [canGuide, guideTeamId])

  // The caller's own activities, debounced; a slower earlier response never
  // overwrites a newer one.
  useEffect(() => {
    if (needle.length < MIN_REMOTE_QUERY) {
      setActivities([])
      setLoadingRemote(false)
      return
    }
    let cancelled = false
    setLoadingRemote(true)
    const timer = window.setTimeout(() => {
      api.get<ActivityHit[]>(`/api/activities/search?q=${encodeURIComponent(needle)}`)
        .then((res) => { if (!cancelled) setActivities(res.data ?? []) })
        .catch(() => { if (!cancelled) setActivities([]) })
        .finally(() => { if (!cancelled) setLoadingRemote(false) })
    }, REMOTE_DEBOUNCE_MS)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [needle])

  const groups = useMemo<ResultGroup[]>(() => {
    if (!needle) return []
    const pages: ResultItem[] = [
      ...visibleAppPages(user).map((p) => ({ key: `page:${p.to}`, label: t(p.labelKey), icon: p.icon, href: p.to })),
      ...(hasPermission(user, SETTINGS_PAGE.pageKey)
        ? [{ key: 'page:/settings', label: t(SETTINGS_PAGE.labelKey), icon: SETTINGS_PAGE.icon, href: SETTINGS_PAGE.to }]
        : []),
    ].filter((i) => matches(i.label, needle)).slice(0, LOCAL_RESULTS_PER_GROUP)

    const dashboards: ResultItem[] = hasPermission(user, 'dashboard')
      ? visibleDashboardGroups(user, projectsOn).flatMap((g) => g.tabs.map((tt) => ({
        key: `dashboard:${tt.key}`,
        label: t(tt.labelKey, { context: crmCtx }),
        detail: t(g.groupKey),
        icon: LayoutDashboard,
        href: dashboardHref(tt.key),
      })))
        .filter((i) => matches(i.label, needle) || matches(i.detail, needle))
        .sort((a, b) => Number(matches(b.label, needle)) - Number(matches(a.label, needle)))
        .slice(0, LOCAL_RESULTS_PER_GROUP)
      : []

    // The Guide's activity type cards: a match on the type's name or on any
    // of its Guide text or Subtypes, with the matching words as the detail.
    const guide: ResultItem[] = canGuide && guideTeamId
      ? [
        ...guideCardTypes(activityTypes).flatMap((at): ResultItem[] => {
          const subtypes = (subtypesByTypeId[at.id] ?? []).map((st) => st.name).join(', ')
          const texts = [at.useThisWhen, at.usuallyAttachTo, at.examples, subtypes].filter((x): x is string => !!x?.trim())
          const nameHit = matches(at.name, needle)
          const textHit = texts.map((x) => snippet(x, needle)).find((x) => x !== null) ?? null
          if (!nameHit && !textHit) return []
          return [{
            key: `guide:${at.id}`,
            label: at.name,
            detail: textHit ?? t('guide.title'),
            icon: LifeBuoy,
            href: `/guide#${guideTypeAnchor(at.id)}`,
          }]
        }),
        ...(() => {
          const label = t('guide.distinctions_title')
          const hit = distinctions?.trim() ? snippet(distinctions, needle) : null
          if (!hit && !(distinctions?.trim() && matches(label, needle))) return []
          return [{ key: 'guide:distinctions', label, detail: hit ?? t('guide.title'), icon: GitCompareArrows, href: `/guide#${GUIDE_DISTINCTIONS_ANCHOR}` }]
        })(),
      ].slice(0, LOCAL_RESULTS_PER_GROUP)
      : []

    const adminItems: ResultItem[] = hasPermission(user, 'admin')
      ? ADMIN_CATEGORIES.flatMap((cat) => cat.items
        .filter((key) => canOpenAdminSection(user, key))
        .map((key) => ({
          key: `admin:${key}`,
          label: t(`admin.sections.${key}`, { context: crmCtx }),
          detail: t(cat.labelKey),
          icon: SECTION_ICONS[key],
          href: `/admin?section=${key}`,
        })))
        .filter((i) => matches(i.label, needle) || (i.detail !== undefined && matches(i.detail, needle)))
        // A section whose own name matches outranks one matched only by its
        // category ("audit" → Audit Log before the rest of Monitoring & Audit).
        .sort((a, b) => Number(matches(b.label, needle)) - Number(matches(a.label, needle)))
        .slice(0, LOCAL_RESULTS_PER_GROUP)
      : []

    // The manual's sections, matched on their title or their text. A section
    // about a page the user can't open is left out.
    const help: ResultItem[] = canGuide
      ? HOW_TO_USE_SECTIONS
        .filter(({ id }) => {
          const pageKey = HOW_TO_USE_SECTION_PAGE_KEY[id]
          return !pageKey || hasPermission(user, pageKey)
        })
        .flatMap(({ id, icon }): ResultItem[] => {
          const label = t(`how_to_use.toc.${id}`)
          const titleHit = matches(label, needle) || matches(t(`how_to_use.${id}_title`), needle)
          const bodyHit = snippet(t(`how_to_use.${id}_body`), needle)
          if (!titleHit && !bodyHit) return []
          return [{ key: `help:${id}`, label, detail: titleHit ? t('how_to_use.title') : bodyHit ?? undefined, icon, href: howToUseHref(id) }]
        })
        .slice(0, LOCAL_RESULTS_PER_GROUP)
      : []

    const acts: ResultItem[] = activities.map((a) => {
      const start = new Date(a.startDatetime)
      const linked = [a.crmWhatName, a.crmWhoName].filter(Boolean).join(' · ')
      return {
        key: `activity:${a.id}`,
        label: a.title,
        detail: [format(start, 'MMM d, yyyy'), linked, a.status === 'draft' ? t('search.draft') : null].filter(Boolean).join(' · '),
        icon: CalendarCheck,
        href: `/?openActivityId=${encodeURIComponent(a.id)}&startDate=${format(start, 'yyyy-MM-dd')}`,
      }
    })

    return [
      { key: 'pages', label: t('search.groups.pages'), items: pages },
      { key: 'dashboards', label: t('search.groups.dashboards'), items: dashboards },
      { key: 'guide', label: t('search.groups.guide'), items: guide },
      { key: 'admin', label: t('search.groups.admin'), items: adminItems },
      { key: 'help', label: t('search.groups.help'), items: help },
      { key: 'activities', label: t('search.groups.activities'), items: acts },
    ].filter((g) => g.items.length > 0)
  }, [needle, user, t, crmCtx, activities, projectsOn, canGuide, guideTeamId, activityTypes, subtypesByTypeId, distinctions])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  useEffect(() => { setHighlight(0) }, [needle])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function go(item: ResultItem) {
    onClose()
    navigate(item.href)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (flat.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % flat.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + flat.length) % flat.length) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flat[highlight]
      if (item) go(item)
    }
  }

  let index = -1
  const showEmpty = needle.length > 0 && flat.length === 0 && !loadingRemote

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center p-4 pt-[10vh] print:hidden">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('search.dialog_label')}
        className="relative z-10 flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 dark:border-gray-700">
          <Search className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="global-search-results"
            aria-activedescendant={flat[highlight] ? `global-search-${highlight}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
          />
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div ref={listRef} id="global-search-results" role="listbox" className="overflow-y-auto p-2">
          {!needle && (
            <p className="flex items-center gap-2 px-2 py-6 text-sm text-gray-500 dark:text-gray-400">
              <BookOpenCheck className="h-4 w-4 shrink-0" />
              {t('search.hint')}
            </p>
          )}
          {showEmpty && (
            <p className="px-2 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{t('search.no_results')}</p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="mb-2 last:mb-0">
              <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                {group.label}
              </div>
              {group.items.map((item) => {
                index += 1
                const i = index
                const Icon = item.icon
                return (
                  <button
                    key={item.key}
                    id={`global-search-${i}`}
                    data-index={i}
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => go(item)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm',
                      i === highlight ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800/60',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-gray-900 dark:text-gray-100">{item.label}</span>
                      {item.detail && <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{item.detail}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
          {loadingRemote && (
            <p className="px-2 py-2 text-xs text-gray-400 dark:text-gray-500">{t('search.searching_activities')}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
