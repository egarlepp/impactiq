import type { ActivityType } from '../store/team.js'

// The Guide page's activity type cards, shared with the header's global
// search so both show the same types and link to the same anchors.

// Meeting is left out by design: it's the highest-volume, most generic type
// and doesn't need a "when to use this" card.
export function guideCardTypes(types: ActivityType[]): ActivityType[] {
  return types
    .filter((at) => at.isActive && at.name !== 'Meeting')
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export const GUIDE_DISTINCTIONS_ANCHOR = 'guide-distinctions'

export function guideTypeAnchor(typeId: string): string {
  return `guide-type-${typeId}`
}
