import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import { useTeam } from '../../hooks/useTeam.js'
import { MultiSelect } from './multi-select.js'

interface Props {
  selected: string[]
  onChange: (next: string[]) => void
  className?: string
}

// v1.265.0: reusable "Subtype filter" chip — PRD §7/Batch 6: "a Subtype
// filter chip reused app-wide". Options come from the active team's
// Subtypes grouped by their parent Activity Type name, reusing useTeam()'s
// activityTypes + subtypesByTypeId (already fetched once for the Log
// Activity form / Guide page — no extra request here).
//
// Renders nothing when the team has no Subtypes configured, or hasn't
// turned Subtypes on (teams.subtypes_enabled) — per CLAUDE.md §7, a team
// that hasn't configured Subtypes shouldn't grow an extra dropdown just
// because the feature shipped.
export function SubtypeFilter({ selected, onChange, className }: Props) {
  const { t } = useTranslation()
  const { activeTeam, activityTypes, subtypesByTypeId } = useTeam()

  const options = useMemo(() => {
    const opts: { value: string; label: string; group: string; groupIconName?: string; groupIconColor?: string }[] = []
    for (const type of activityTypes) {
      const subs = subtypesByTypeId[type.id] ?? []
      for (const s of subs) {
        opts.push({
          value: s.id,
          label: s.name,
          group: type.name,
          groupIconName: type.icon ?? undefined,
          groupIconColor: type.color ?? undefined,
        })
      }
    }
    return opts
  }, [activityTypes, subtypesByTypeId])

  if (!activeTeam?.subtypesEnabled || options.length === 0) return null

  return (
    <MultiSelect
      label={t('leader.filter_subtype', 'Subtype')}
      labelIcon={Layers}
      placeholder={t('leader.filter_all', 'All')}
      options={options}
      selected={selected}
      onChange={onChange}
      className={className}
    />
  )
}
