// v1.445.0: every What's new bullet carries one of four categories, the same
// ones CriteriaIQ's Change Log uses. Kept out of changelog.ts so the client can
// import the order and grouping helper without pulling in the whole (lazy-
// loaded) changelog, and so the server's App Updates parser can validate them.
export const CHANGELOG_CATEGORIES = ['security', 'feature', 'improvement', 'fix'] as const

export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number]

export interface ChangelogItem {
  category: ChangelogCategory
  text: string
}

export function isChangelogCategory(value: unknown): value is ChangelogCategory {
  return typeof value === 'string' && (CHANGELOG_CATEGORIES as readonly string[]).includes(value)
}

// Groups one release's bullets by category in display order (Security first,
// Fixes last), keeping each bullet's original order inside its group and
// dropping empty groups.
export function groupChangelogItems(
  items: readonly ChangelogItem[],
): Array<{ category: ChangelogCategory; items: ChangelogItem[] }> {
  return CHANGELOG_CATEGORIES
    .map((category) => ({ category, items: items.filter((item) => item.category === category) }))
    .filter((group) => group.items.length > 0)
}
