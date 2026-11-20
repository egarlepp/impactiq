import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Building2, Briefcase, Megaphone, UserPlus } from 'lucide-react'
import { useCrmFeatures } from '../../store/crmFeatures.js'
import { useCrmLabelContext } from '../../store/crmProvider.js'

// v1.122.0: shared help popover that explains how ImpactIQ associates
// SF objects to an Account when the "Include All" toggle is on. Same
// component used on the Account drill-down modal AND anywhere the user
// picks a Campaign / Lead (Log Activity drawer's SfSearch) so the
// definitions stay in one place.
// v1.123.0: rendered through a portal with computed fixed coords so
// the popover isn't clipped by ancestor `overflow-y-auto` (modal body)
// and doesn't inherit `uppercase` / tracking from the section label
// it sits inside.
export function SfRelationshipHelp({
  className,
  size = 'sm',
}: {
  className?: string
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation()
  const crmCtx = useCrmLabelContext()
  const { campaignsEnabled, leadsEnabled } = useCrmFeatures()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return }
    const rect = btnRef.current.getBoundingClientRect()
    const POP_WIDTH = 320
    const MARGIN = 8
    const preferredLeft = rect.right - POP_WIDTH
    const left = Math.max(MARGIN, Math.min(preferredLeft, window.innerWidth - POP_WIDTH - MARGIN))
    const top = rect.bottom + 4
    setPos({ top, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (popRef.current?.contains(target)) return
      setOpen(false)
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    function handleResize() { setOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleResize, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleResize, true)
    }
  }, [open])

  const iconSize = size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        title={t('sf_relationship.help_title', { defaultValue: 'How Account relationships work', context: crmCtx })}
        aria-label={t('sf_relationship.help_title', { defaultValue: 'How Account relationships work', context: crmCtx })}
        className={`inline-flex items-center rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200 ${className ?? ''}`}
      >
        <HelpCircle className={iconSize} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 320 }}
          className="z-[100] rounded-lg border border-gray-200 bg-white p-3 text-xs normal-case tracking-normal shadow-lg dark:border-gray-700 dark:bg-gray-900"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-sm font-semibold normal-case tracking-normal text-gray-900 dark:text-gray-100">
            {t('sf_relationship.title', { defaultValue: 'How activities roll up to an Account', context: crmCtx })}
          </p>
          <ul className="flex flex-col gap-2 normal-case tracking-normal text-gray-700 dark:text-gray-300">
            <li className="flex items-start gap-2">
              <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <span>
                <b className="text-gray-900 dark:text-gray-100">{t('sf.account', { context: crmCtx })}</b>{' '}
                — {t('sf_relationship.account', { defaultValue: 'Activities logged directly against this Account record.', context: crmCtx })}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Briefcase className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <span>
                <b className="text-gray-900 dark:text-gray-100">{t('sf.opportunity', { context: crmCtx })}</b>{' '}
                — {t('sf_relationship.opportunity', { defaultValue: 'Activities on any Opportunity whose parent Account is this Account (via Opportunity.AccountId).', context: crmCtx })}
              </span>
            </li>
            {campaignsEnabled && (
            <li className="flex items-start gap-2">
              <Megaphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <span>
                <b className="text-gray-900 dark:text-gray-100">{t('sf.campaign', 'Campaign')}</b>{' '}
                — {t('sf_relationship.campaign', { defaultValue: 'Activities on any Campaign tied to an Opportunity under this Account (via Opportunity.CampaignId). Campaigns without an Opportunity in this Account are not counted.', context: crmCtx })}
              </span>
            </li>
            )}
            {leadsEnabled && (
            <li className="flex items-start gap-2">
              <UserPlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <span>
                <b className="text-gray-900 dark:text-gray-100">{t('sf.lead', 'Lead')}</b>{' '}
                — {t('sf_relationship.lead', { defaultValue: 'Activities on Leads that were converted into this Account (via Lead.ConvertedAccountId). Unconverted Leads are not counted.', context: crmCtx })}
              </span>
            </li>
            )}
          </ul>
          <p className="mt-3 text-[11px] italic normal-case tracking-normal text-gray-500 dark:text-gray-400">
            {t('sf_relationship.footnote', { defaultValue: 'Each activity counts once — an Opportunity activity rolls up under its parent Account but is not double-counted.', context: crmCtx })}
          </p>
        </div>,
        document.body,
      )}
    </>
  )
}
