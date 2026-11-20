import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { BookOpenCheck, ArrowLeft } from 'lucide-react'
import { PageHeader } from '../components/ui/page-header.js'
import { MarkdownProse } from '../components/ui/markdown-prose.js'
import { HOW_TO_USE_SECTIONS } from '../lib/howToUse.js'

// v1.367.0: a standalone, app-wide "user manual" — distinct from Guide.tsx,
// which only documents per-Activity-Type "when to use this type" content.
// This page is entirely static (no admin-editable DB content, no per-team
// scoping needed — it's the same manual for every team), so a well-organized
// React page with real i18n strings is simpler and more appropriate than
// trying to force it through the DB-backed Guide content model. Reachable
// only via the link banner at the top of Guide.tsx (§ nav conventions — this
// stays under the same Guide "section" rather than becoming its own
// top-level sidebar entry, per the explicit request).
//
// Content lives in the `how_to_use` i18n namespace as Markdown-bearing
// strings, rendered through the same MarkdownProse component the existing
// Guide Distinctions section already uses, so headings/bold/lists render
// consistently with the rest of the app's rich-text surfaces.

export default function HowToUseImpactIQ() {
  const { t } = useTranslation()
  // v1.420.0: the header's ? button and global search link straight to a
  // section (#howto-<id>). A client-side navigation doesn't scroll to the
  // hash on its own, so do it once the section has rendered.
  const { hash } = useLocation()
  useEffect(() => {
    if (!hash) return
    const id = decodeURIComponent(hash.slice(1))
    const frame = requestAnimationFrame(() => { document.getElementById(id)?.scrollIntoView({ block: 'start' }) })
    return () => cancelAnimationFrame(frame)
  }, [hash])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={BookOpenCheck}
        title={t('how_to_use.title', 'How to Use ImpactIQ')}
        subtitle={t('how_to_use.subtitle', "A complete walkthrough of the app for every role — start here if you're new.")}
      />

      <div className="relative flex-1 overflow-y-auto bg-gray-100 p-6 dark:bg-gray-900">
        {/* v1.367.2 tried a grid-cell overlay to stretch the watermark to full
            content height — reverted (v1.368.1): stretching it to this page's
            much-taller box changed its crop/zoom, visibly distorting it. Back
            to the original, non-stretched `absolute inset-0` sizing; the
            `bg-gray-100 dark:bg-gray-900` on the scroll container itself (one
            step off the page's own `bg-gray-50`/`dark:bg-gray-950`, §20's
            PageShell) is what actually fixes the long-page gap — an element
            background-color always extends across the full scrollable
            height, unlike an absolutely positioned child pinned to the
            container's own CSS box. See Guide.tsx for the identical fix. */}
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
          <Link
            to="/guide"
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('how_to_use.back_to_guide', 'Back to Guide')}
          </Link>

          {/* Table of contents */}
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              {t('how_to_use.toc_title', 'On this page')}
            </h2>
            <nav className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {HOW_TO_USE_SECTIONS.map(({ id, icon: Icon }) => (
                <a
                  key={id}
                  href={`#howto-${id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <Icon className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                  {t(`how_to_use.toc.${id}`)}
                </a>
              ))}
            </nav>
          </div>

          {HOW_TO_USE_SECTIONS.map(({ id, icon: Icon }) => (
            <section
              key={id}
              id={`howto-${id}`}
              className="scroll-mt-6 rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
            >
              <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
                <Icon className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
                {t(`how_to_use.${id}_title`)}
              </h2>
              <MarkdownProse className="text-sm text-gray-700 dark:text-gray-300">
                {t(`how_to_use.${id}_body`)}
              </MarkdownProse>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
