import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { LifeBuoy, GitCompareArrows, Users2, BookOpenCheck, ArrowRight } from 'lucide-react'
import { PageHeader } from '../components/ui/page-header.js'
import { Spinner } from '../components/ui/spinner.js'
import { DynamicIcon } from '../components/ui/icon-picker.js'
import { MarkdownProse } from '../components/ui/markdown-prose.js'
import { api } from '../lib/api.js'
import { useTeam } from '../hooks/useTeam.js'
import { cn } from '../lib/utils.js'
import { GUIDE_DISTINCTIONS_ANCHOR, guideCardTypes, guideTypeAnchor } from '../lib/activityTypeGuide.js'

// v1.255.0: in-app reference for when to use each activity type, what it's
// usually attached to in Salesforce, and worked examples — read-only,
// content is entirely admin-authored (Admin → Activity Types' "Classify
// Activity" section + top-of-page "Guide: Distinctions"). See
// ActivityTypesConfig.tsx for the write side.

export default function Guide() {
  const { t } = useTranslation()
  // v1.256.0: subtypesByTypeId now lives in the team store (fetched once,
  // shared with ActivityForm/TemplatesSection) instead of this page's own
  // fetch of the same endpoint.
  const { active, activityTypes, subtypesByTypeId } = useTeam()
  const [distinctions, setDistinctions] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active || active.isAll) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    void api.get<{ guideDistinctions: string | null }>(`/api/teams/${active.id}/guide-distinctions`).then((res) => {
      if (cancelled) return
      setDistinctions(res.data?.guideDistinctions ?? null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [active])

  // v1.377.0: every active type except Meeting gets a card (icon + color
  // included), even before an admin fills in its Guide text, so a newly
  // added type shows up here right away.
  const cards = guideCardTypes(activityTypes)

  // v1.421.0: search results link to a card or to Distinctions by #anchor.
  // Scroll there once the content has rendered, and outline it.
  const { hash } = useLocation()
  const target = hash.startsWith('#') ? hash.slice(1) : ''
  useEffect(() => {
    if (!target || loading) return
    const frame = requestAnimationFrame(() => {
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [target, loading, cards.length, distinctions])
  const targetRing = 'ring-2 ring-blue-500 dark:ring-blue-400'

  return (
    // Match Settings / Dashboard / My Notes: outer has NO padding so the
    // PageHeader sits flush with the top nav edge; the inner content div
    // owns its own p-6 (24px) so the header bar looks consistent across
    // pages while the body content still gets real breathing room from
    // the sidebar and the browser edge.
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader icon={LifeBuoy} title={t('guide.title', 'Guide')} subtitle={t('guide.subtitle', 'When to use each activity type, what it usually attaches to, and worked examples.')} />

      <div className="relative flex-1 overflow-y-auto bg-gray-100 p-6 dark:bg-gray-900">
      {/* v1.367.2 tried a grid-cell overlay to stretch the watermark to full
          content height — reverted (v1.368.1): stretching the image to a much
          taller box changed its crop/zoom, visibly distorting it. Back to the
          original, non-stretched `absolute inset-0` sizing (its natural crop
          at the container's own on-screen height); the `bg-gray-100 dark:
          bg-gray-900` on the scroll container itself (one step off the page's
          own `bg-gray-50`/`dark:bg-gray-950`, §20's PageShell) is what actually
          fixes the long-page gap — a plain element background-color always
          extends across the FULL scrollable height, unlike an absolutely
          positioned child pinned to the container's own CSS box, so scrolling
          past the image's bottom edge reveals this same tone instead of a
          mismatched blank patch. Do not reintroduce the grid wrapper. */}
      {/* World watermark — matches Admin.tsx's treatment exactly (same
          image, opacity, blend mode, and `background-size: cover` at a
          plain `right center` position). See Admin.tsx for the history of
          why `cover` with no positional offset is the only safe choice
          here — re-verify at both a narrow and a very wide viewport before
          changing backgroundPosition/backgroundSize on this div.
          v1.355.0: world.webp's own pixels are near-black navy — `screen`
          blend only lightens using the blend layer's own color, so
          screening that near-black asset onto the dark page background was
          invisible regardless of opacity. `invert(1)` flips it to
          near-white first, same fix as Admin.tsx — keep both in sync. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply dark:opacity-20 dark:mix-blend-screen dark:[filter:invert(1)]"
        style={{
          backgroundImage: "url('/world.webp')",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right center',
          backgroundSize: 'cover',
        }}
      />
      <div className="relative flex flex-col gap-6">
      {/* v1.367.0: prominent link to the new, app-wide "How to Use ImpactIQ"
          onboarding manual — this Guide page only documents per-Activity-Type
          "when to use this type" content, so a brand-new user needs a way to
          find the full walkthrough from here. Lives under the same Guide
          route rather than becoming a separate top-level sidebar entry. */}
      <Link
        to="/guide/how-to-use"
        className="flex items-center justify-between gap-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 transition-colors hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:hover:bg-blue-950/70"
      >
        <div className="flex items-center gap-3">
          <BookOpenCheck className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div>
            <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">{t('guide.how_to_use_banner_title', 'New here? Read the full "How to Use ImpactIQ" guide')}</p>
            <p className="text-xs text-blue-700 dark:text-blue-400">{t('guide.how_to_use_banner_body', 'A complete walkthrough of the whole app — logging activities, Salesforce, nudges, dashboards, admin, and more.')}</p>
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-blue-700 dark:text-blue-300">
          {t('guide.how_to_use_banner_cta', 'Open the guide')}
          <ArrowRight className="h-4 w-4" />
        </span>
      </Link>

      {(!active || active.isAll) && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-gray-300 py-10 text-center dark:border-gray-700">
          <Users2 className="h-8 w-8 text-gray-400 dark:text-gray-600" />
          <p className="font-medium text-gray-700 dark:text-gray-200">{t('guide.select_team_title', 'Select a specific team')}</p>
          <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">{t('guide.select_team_body', 'The Guide is team-scoped — switch out of All Teams to see its activity type reference.')}</p>
        </div>
      )}

      {active && !active.isAll && loading && (
        <div className="flex justify-center py-16"><Spinner /></div>
      )}

      {active && !active.isAll && !loading && (
        <>
          {cards.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-gray-300 py-10 text-center dark:border-gray-700">
              <LifeBuoy className="h-8 w-8 text-gray-400 dark:text-gray-600" />
              <p className="font-medium text-gray-700 dark:text-gray-200">{t('guide.empty_title', 'Nothing here yet')}</p>
              <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">{t('guide.empty_body', 'An admin hasn’t filled in any Guide content for this team’s activity types yet — see Admin → Activity Types → Classify Activity.')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {cards.map((at) => (
                <div key={at.id} id={guideTypeAnchor(at.id)} className={cn('flex scroll-mt-4 flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900', target === guideTypeAnchor(at.id) && targetRing)}>
                  <div className="flex items-center gap-2">
                    {at.icon && (
                      <DynamicIcon name={at.icon} className="h-5 w-5 shrink-0" style={at.color ? { color: at.color } : undefined} />
                    )}
                    {!at.icon && at.color && <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: at.color }} />}
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{at.name}</h3>
                  </div>
                  {!(at.useThisWhen?.trim() || at.usuallyAttachTo?.trim() || at.examples?.trim()) && (
                    <p className="text-xs italic text-gray-400 dark:text-gray-500">{t('guide.no_details', 'No guide details yet. An admin can add them in Admin → Activity Types → Classify Activity.')}</p>
                  )}
                  {at.useThisWhen?.trim() && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{t('guide.use_this_when', 'Use This When')}</p>
                      <p className="text-xs text-gray-700 dark:text-gray-300">{at.useThisWhen}</p>
                    </div>
                  )}
                  {at.usuallyAttachTo?.trim() && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{t('guide.usually_attach_to', 'Usually Attach To')}</p>
                      <p className="text-xs text-gray-700 dark:text-gray-300">{at.usuallyAttachTo}</p>
                    </div>
                  )}
                  {at.examples?.trim() && (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{t('guide.examples', 'Examples')}</p>
                      <p className="text-xs text-gray-700 dark:text-gray-300">{at.examples}</p>
                    </div>
                  )}
                  {(subtypesByTypeId[at.id] ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {(subtypesByTypeId[at.id] ?? []).map((s) => (
                        <span key={s.id} className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
                          {s.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {distinctions?.trim() && (
            <div id={GUIDE_DISTINCTIONS_ANCHOR} className={cn('scroll-mt-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900', target === GUIDE_DISTINCTIONS_ANCHOR && targetRing)}>
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <GitCompareArrows className="h-4 w-4" />
                {t('guide.distinctions_title', 'Distinctions')}
              </h3>
              <MarkdownProse className="text-sm text-gray-700 dark:text-gray-300">{distinctions}</MarkdownProse>
            </div>
          )}
        </>
      )}
      </div>
      </div>
    </div>
  )
}
