import { useTranslation } from 'react-i18next'
import { groupChangelogItems, type ChangelogCategory, type ChangelogItem } from '../../../shared/changelogCategories.js'
import { cn } from '../../lib/utils.js'

// v1.445.0: one release's bullets grouped under CriteriaIQ's four Change Log
// headings, each with an emoji and its own color on the heading and left rule.
const CATEGORY_STYLE: Record<ChangelogCategory, { emoji: string; rule: string; heading: string }> = {
  security: {
    emoji: '🔒',
    rule: 'border-red-500 dark:border-red-400',
    heading: 'text-red-700 dark:text-red-300',
  },
  feature: {
    emoji: '🆕',
    rule: 'border-green-500 dark:border-green-400',
    heading: 'text-green-700 dark:text-green-300',
  },
  improvement: {
    emoji: '🔧',
    rule: 'border-blue-500 dark:border-blue-400',
    heading: 'text-blue-700 dark:text-blue-300',
  },
  fix: {
    emoji: '🐛',
    rule: 'border-amber-500 dark:border-amber-400',
    heading: 'text-amber-700 dark:text-amber-300',
  },
}

export function ChangelogHighlights({ items, className }: { items: readonly ChangelogItem[]; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={cn('mt-1 space-y-1.5', className)}>
      {groupChangelogItems(items).map(({ category, items: groupItems }) => {
        const style = CATEGORY_STYLE[category]
        return (
          <section key={category} className={cn('border-l-2 pl-2', style.rule)}>
            <h4 className={cn('flex items-center gap-1 text-[11px] font-semibold', style.heading)}>
              <span aria-hidden="true">{style.emoji}</span>
              {t(`changelog.category.${category}`)}
            </h4>
            <ul className="ml-3 list-disc text-[11px] leading-tight text-gray-600 dark:text-gray-300">
              {groupItems.map((item, i) => <li key={i}>{item.text}</li>)}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
