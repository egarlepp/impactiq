import { useTranslation } from 'react-i18next'
import { useTeam } from '../../hooks/useTeam.js'
import { Label } from '../ui/label.js'

interface Props {
  selectedIds: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}

export function TeamAssignmentPicker({ selectedIds, onChange, disabled }: Props) {
  const { t } = useTranslation()
  const { teams } = useTeam()

  if (teams.length === 0) return null

  function toggle(id: string) {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t('admin.team_assignment.label')}</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {teams.map((team) => (
          <label key={team.id} className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              disabled={disabled}
              checked={selectedIds.includes(team.id)}
              onChange={() => toggle(team.id)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            {team.name}
          </label>
        ))}
      </div>
      {selectedIds.length === 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('admin.team_assignment.none_warning')}</p>
      )}
    </div>
  )
}
